package websocket

import (
	"sync"
)

// Hub manages all active WebSocket connections.
type Hub struct {
	clients    map[*Client]struct{}
	broadcast  chan Message
	register   chan *Client
	unregister chan *Client
	mu         sync.RWMutex
}

// NewHub creates a new Hub ready to Run.
func NewHub() *Hub {
	return &Hub{
		clients:    make(map[*Client]struct{}),
		broadcast:  make(chan Message, 256),
		register:   make(chan *Client, 16),
		unregister: make(chan *Client, 16),
	}
}

// Run processes register, unregister, and broadcast events.
// It must be started in its own goroutine.
func (h *Hub) Run() {
	for {
		select {
		case c := <-h.register:
			h.mu.Lock()
			h.clients[c] = struct{}{}
			h.mu.Unlock()

		case c := <-h.unregister:
			h.drop(c)

		case msg := <-h.broadcast:
			h.deliver(msg)
		}
	}
}

// deliver fans msg out to every client, dropping any whose send buffer has
// filled up (a peer that cannot keep up is treated as gone).
func (h *Hub) deliver(msg Message) {
	h.mu.RLock()
	var stalled []*Client
	for c := range h.clients {
		if !c.trySend(msg) {
			stalled = append(stalled, c)
		}
	}
	h.mu.RUnlock()

	// Removed inline rather than via h.unregister: Run is the only reader of
	// that channel, so sending to it from here would deadlock the hub once the
	// channel buffer filled.
	for _, c := range stalled {
		h.drop(c)
	}
}

// drop removes a client from the hub and signals its write pump to finish.
func (h *Hub) drop(c *Client) {
	h.mu.Lock()
	_, known := h.clients[c]
	delete(h.clients, c)
	h.mu.Unlock()

	if known {
		c.close()
	}
}

// Broadcast enqueues msg for delivery to all connected clients (non-blocking).
func (h *Hub) Broadcast(msg Message) {
	select {
	case h.broadcast <- msg:
	default:
		// Drop if the broadcast channel itself is full rather than blocking the caller.
	}
}

// Register adds a client to the hub.
func (h *Hub) Register(c *Client) {
	h.register <- c
}

// Unregister removes a client from the hub and stops its write pump.
func (h *Hub) Unregister(c *Client) {
	h.unregister <- c
}

// ClientCount returns the number of currently connected clients.
func (h *Hub) ClientCount() int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.clients)
}
