package websocket

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"sync"
	"time"

	ws "github.com/gorilla/websocket"

	"github.com/google/uuid"
	"lofi-radio-backend/internal/models"
	"lofi-radio-backend/internal/player"
)

const (
	writeWait   = 10 * time.Second
	pongWait    = 60 * time.Second
	pingPeriod  = 30 * time.Second
	sendBufSize = 16
)

var upgrader = ws.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	CheckOrigin: func(r *http.Request) bool {
		return true // CORS handled at HTTP layer
	},
}

// QueueManager is the subset of queue.Manager the client uses.
type QueueManager interface {
	NextSong(ctx context.Context) (*models.Song, error)
	ListQueue(ctx context.Context) ([]*models.QueueItem, error)
	TotalSongs(ctx context.Context) (int, error)
}

// Client represents a single connected WebSocket peer.
type Client struct {
	hub          *Hub
	conn         *ws.Conn
	send         chan Message
	queueMgr     QueueManager
	baseURL      string
	stateTracker *player.StateTracker
	currentSong  *models.Song
	mu           sync.Mutex

	// closed is closed exactly once, when the hub drops this client. The send
	// channel itself is deliberately never closed: the read pump, the hub's
	// broadcast loop and the initial-state sender may all still be mid-send,
	// and a send on a closed channel panics even inside a select with a
	// default. Signalling through a separate channel lets senders bail safely.
	closed    chan struct{}
	closeOnce sync.Once
}

// NewClient constructs a Client. Call ServeWS instead of this directly.
func NewClient(hub *Hub, conn *ws.Conn, queueMgr QueueManager, baseURL string, st *player.StateTracker) *Client {
	return &Client{
		hub:          hub,
		conn:         conn,
		send:         make(chan Message, sendBufSize),
		queueMgr:     queueMgr,
		baseURL:      baseURL,
		stateTracker: st,
		closed:       make(chan struct{}),
	}
}

// close marks the client as gone and wakes its write pump. Safe to call
// repeatedly and from any goroutine.
func (c *Client) close() {
	c.closeOnce.Do(func() { close(c.closed) })
}

// trySend queues msg for delivery without ever blocking the caller. It reports
// false when the client is already closed or its send buffer is full.
func (c *Client) trySend(msg Message) bool {
	// Checked in two steps on purpose. A single select listing both cases
	// would pick at random whenever both are ready, so a closed client with a
	// free buffer slot would still accept messages.
	select {
	case <-c.closed:
		return false
	default:
	}

	select {
	case c.send <- msg:
		return true
	default:
		return false
	}
}

// ServeWS upgrades the HTTP connection to WebSocket, registers the client with
// the hub, sends the initial state message, and starts the read/write pumps.
func ServeWS(hub *Hub, queueMgr QueueManager, baseURL string, st *player.StateTracker, w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("websocket upgrade error: %v", err)
		return
	}

	c := NewClient(hub, conn, queueMgr, baseURL, st)
	hub.Register(c)

	// Queue the initial snapshot before the pumps start, so it is the first
	// frame the peer receives. The request context is not used here: it is
	// cancelled as soon as ServeWS returns, which would abort these lookups.
	if msg, encErr := Encode(MsgState, c.snapshotState(context.Background())); encErr == nil {
		c.trySend(msg)
	}

	go c.writePump()
	go c.readPump()
}

// snapshotState builds the PlayerState sent to a peer on connect. Lookup
// failures degrade to zero counts rather than withholding the whole snapshot.
func (c *Client) snapshotState(ctx context.Context) models.PlayerState {
	state := models.PlayerState{CurrentSong: c.stateTracker.GetCurrentSong()}
	if items, err := c.queueMgr.ListQueue(ctx); err == nil {
		state.QueueLength = len(items)
	} else {
		log.Printf("websocket initial state: list queue: %v", err)
	}
	if total, err := c.queueMgr.TotalSongs(ctx); err == nil {
		state.TotalSongs = total
	} else {
		log.Printf("websocket initial state: count songs: %v", err)
	}
	return state
}

// readPump reads incoming messages from the WebSocket connection.
func (c *Client) readPump() {
	defer func() {
		c.hub.Unregister(c)
		c.conn.Close()
	}()

	c.conn.SetReadDeadline(time.Now().Add(pongWait))
	c.conn.SetPongHandler(func(string) error {
		c.conn.SetReadDeadline(time.Now().Add(pongWait))
		return nil
	})

	for {
		_, data, err := c.conn.ReadMessage()
		if err != nil {
			if ws.IsUnexpectedCloseError(err, ws.CloseGoingAway, ws.CloseAbnormalClosure) {
				log.Printf("websocket read error: %v", err)
			}
			return
		}

		var msg Message
		if err := json.Unmarshal(data, &msg); err != nil {
			log.Printf("websocket unmarshal error: %v", err)
			continue
		}

		c.handleMessage(msg)
	}
}

// handleMessage dispatches an incoming client message.
func (c *Client) handleMessage(msg Message) {
	ctx := context.Background()

	switch msg.Type {
	case MsgNeedSong:
		c.sendNextSong(ctx)

	case MsgSongFinished:
		// Song is already marked played when it starts; just request the next one.
		c.sendNextSong(ctx)

	case MsgPeekNext:
		// Client wants to prebuffer the next song without dequeuing it.
		c.sendPrebuffer(ctx)

	case MsgHeartbeat:
		c.trySend(Message{Type: MsgHeartbeatAck})

	default:
		log.Printf("unknown message type: %q", msg.Type)
	}
}

// sendNextSong fetches the next song from the queue and pushes a play_song
// message to this client. It also broadcasts now_playing and queue_updated to
// all clients so management UIs stay in sync.
func (c *Client) sendNextSong(ctx context.Context) {
	song, err := c.queueMgr.NextSong(ctx)
	if err != nil {
		log.Printf("next song error: %v", err)
		if errMsg, encErr := Encode(MsgError, ErrorPayload{Message: err.Error()}); encErr == nil {
			c.trySend(errMsg)
		}
		return
	}

	items, _ := c.queueMgr.ListQueue(ctx)
	queueDepth := len(items)

	payload := PlaySongPayload{
		Song:       *song,
		StreamURL:  c.streamURL(song.ID),
		HistoryID:  uuid.New().String(),
		QueueDepth: queueDepth,
	}

	playMsg, err := Encode(MsgPlaySong, payload)
	if err != nil {
		log.Printf("encode play_song: %v", err)
		return
	}

	// Update shared state tracker so the REST player endpoint is current.
	if c.stateTracker != nil {
		c.stateTracker.SetCurrentSong(song)
	}

	c.mu.Lock()
	c.currentSong = song
	c.mu.Unlock()

	if !c.trySend(playMsg) {
		log.Printf("send buffer full or client closed, dropping play_song")
	}

	// Broadcast to all peers so management UIs get live updates.
	if nowMsg, encErr := Encode(MsgNowPlaying, NowPlayingPayload{Song: *song, QueueDepth: queueDepth}); encErr == nil {
		c.hub.Broadcast(nowMsg)
	}
	if queueMsg, encErr := Encode(MsgQueueUpdated, QueueUpdatedPayload{QueueDepth: queueDepth, Reason: "song_started"}); encErr == nil {
		c.hub.Broadcast(queueMsg)
	}
}

// sendPrebuffer peeks at the front of the queue and sends the next song's URL to this
// client for prebuffering. It does NOT dequeue or update shared state.
func (c *Client) sendPrebuffer(ctx context.Context) {
	items, err := c.queueMgr.ListQueue(ctx)
	if err != nil || len(items) == 0 {
		return
	}
	first := items[0]
	if first.Song == nil {
		return
	}
	payload := PlaySongPayload{
		Song:      *first.Song,
		StreamURL: c.streamURL(first.Song.ID),
		HistoryID: "", // intentionally empty — this is a prebuffer hint only
	}
	msg, err := Encode(MsgPrebufferSong, payload)
	if err != nil {
		return
	}
	c.trySend(msg)
}

// streamURL builds the absolute URL a client fetches audio bytes from.
func (c *Client) streamURL(songID string) string {
	return c.baseURL + "/v1/songs/" + songID + "/content"
}

// writePump drains the client's send channel and writes messages to the
// connection. It exits when the hub closes the client or a write fails.
func (c *Client) writePump() {
	ticker := time.NewTicker(pingPeriod)
	defer func() {
		ticker.Stop()
		c.conn.Close()
	}()

	for {
		select {
		case msg := <-c.send:
			c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := c.conn.WriteJSON(msg); err != nil {
				log.Printf("websocket write error: %v", err)
				return
			}

		case <-ticker.C:
			c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := c.conn.WriteMessage(ws.PingMessage, nil); err != nil {
				return
			}

		case <-c.closed:
			c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			c.conn.WriteMessage(ws.CloseMessage, []byte{}) //nolint:errcheck
			return
		}
	}
}
