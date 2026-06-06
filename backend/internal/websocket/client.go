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

	// Send initial state: current song + queue depth.
	go func() {
		items, err := queueMgr.ListQueue(r.Context())
		queueDepth := 0
		if err == nil {
			queueDepth = len(items)
		}
		state := models.PlayerState{
			CurrentSong: st.GetCurrentSong(),
			QueueLength: queueDepth,
		}
		msg, encErr := Encode(MsgState, state)
		if encErr == nil {
			c.send <- msg
		}
	}()

	go c.writePump()
	go c.readPump()
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

	case MsgHeartbeat:
		ack := Message{Type: MsgHeartbeatAck}
		select {
		case c.send <- ack:
		default:
		}

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
		errMsg, encErr := Encode(MsgError, ErrorPayload{Message: err.Error()})
		if encErr == nil {
			select {
			case c.send <- errMsg:
			default:
			}
		}
		return
	}

	items, _ := c.queueMgr.ListQueue(ctx)
	queueDepth := len(items)

	payload := PlaySongPayload{
		Song:       *song,
		StreamURL:  c.baseURL + "/v1/songs/" + song.ID + "/content",
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

	select {
	case c.send <- playMsg:
	default:
		log.Printf("send buffer full, dropping play_song for client")
	}

	// Broadcast to all peers so management UIs get live updates.
	if nowMsg, encErr := Encode(MsgNowPlaying, NowPlayingPayload{Song: *song, QueueDepth: queueDepth}); encErr == nil {
		c.hub.Broadcast(nowMsg)
	}
	if queueMsg, encErr := Encode(MsgQueueUpdated, QueueUpdatedPayload{QueueDepth: queueDepth, Reason: "song_started"}); encErr == nil {
		c.hub.Broadcast(queueMsg)
	}
}

// writePump drains the client's send channel and writes messages to the connection.
func (c *Client) writePump() {
	ticker := time.NewTicker(pingPeriod)
	defer func() {
		ticker.Stop()
		c.conn.Close()
	}()

	for {
		select {
		case msg, ok := <-c.send:
			c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if !ok {
				c.conn.WriteMessage(ws.CloseMessage, []byte{})
				return
			}

			if err := c.conn.WriteJSON(msg); err != nil {
				log.Printf("websocket write error: %v", err)
				return
			}

		case <-ticker.C:
			c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := c.conn.WriteMessage(ws.PingMessage, nil); err != nil {
				return
			}
		}
	}
}
