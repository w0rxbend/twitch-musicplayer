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
			h.mu.Lock()
			if _, ok := h.clients[c]; ok {
				delete(h.clients, c)
				close(c.send)
			}
			h.mu.Unlock()

		case msg := <-h.broadcast:
			h.mu.RLock()
			// Collect clients to remove after releasing the read lock.
			var dead []*Client
			for c := range h.clients {
				select {
				case c.send <- msg:
				default:
					// Client's send buffer is full — mark for removal.
					dead = append(dead, c)
				}
			}
			h.mu.RUnlock()

			// Unregister overflowed clients.
			for _, c := range dead {
				h.Unregister(c)
			}
		}
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

// Unregister removes a client from the hub and closes its send channel.
func (h *Hub) Unregister(c *Client) {
	h.unregister <- c
}

// ClientCount returns the number of currently connected clients.
func (h *Hub) ClientCount() int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.clients)
}
