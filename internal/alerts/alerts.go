// Package alerts delivers notifications over HTTP. Both Telegram and Discord
// take a JSON POST, so one code path covers them and any other webhook
// receiver. Delivery is best effort: an alert that cannot be delivered is
// logged and never blocks the run.
package alerts

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"sync"
	"time"
)

type Level string

const (
	LevelInfo  Level = "info"
	LevelWarn  Level = "warn"
	LevelError Level = "error"
)

// Alert is the payload sent to the webhook.
type Alert struct {
	Level   Level    `json:"level"`
	Title   string   `json:"title"`
	Message string   `json:"message"`
	At      string   `json:"at"`
	Tags    []string `json:"tags,omitempty"`
}

// Notifier posts alerts, rate-limited per title so a flapping condition cannot
// flood the channel.
type Notifier struct {
	url    string
	logger *log.Logger
	client *http.Client

	mu       sync.Mutex
	lastSent map[string]time.Time
	cooldown time.Duration
}

// New returns a Notifier, or nil when no webhook is configured. A nil
// Notifier is safe to use: every method checks for it.
func New(logger *log.Logger) *Notifier {
	// nil is a valid receiver: every method checks Enabled() or returns early.
	url := os.Getenv("ALERT_WEBHOOK_URL")
	if url == "" {
		logger.Print("alerts: ALERT_WEBHOOK_URL not set, notifications disabled")
		return nil
	}

	cooldown := 10 * time.Minute
	if raw := os.Getenv("ALERT_COOLDOWN"); raw != "" {
		if d, err := time.ParseDuration(raw); err == nil {
			cooldown = d
		}
	}

	return &Notifier{
		url:      url,
		logger:   logger,
		client:   &http.Client{Timeout: 10 * time.Second},
		lastSent: map[string]time.Time{},
		cooldown: cooldown,
	}
}

func (n *Notifier) Enabled() bool { return n != nil }

// Notify sends an alert unless the same title fired within the cooldown.
func (n *Notifier) Notify(level Level, title, message string, tags ...string) {
	if n == nil {
		return
	}

	now := time.Now()
	n.mu.Lock()
	if last, seen := n.lastSent[title]; seen && now.Sub(last) < n.cooldown {
		n.mu.Unlock()
		return
	}
	n.lastSent[title] = now
	n.mu.Unlock()

	alert := Alert{
		Level:   level,
		Title:   title,
		Message: message,
		At:      now.UTC().Format(time.RFC3339),
		Tags:    tags,
	}

	if err := n.post(alert); err != nil {
		n.logger.Printf("alerts: delivery failed for %q: %v", title, err)
		return
	}
	n.logger.Printf("alerts: sent %q to webhook", title)
}

// NotifyAsync is for hot paths that must not block the caller.
func (n *Notifier) NotifyAsync(level Level, title, message string, tags ...string) {
	if n == nil {
		return
	}
	go n.Notify(level, title, message, tags...)
}

func (n *Notifier) post(alert Alert) error {
	// Discord wants a {content} field; Telegram and generic receivers read the
	// nested object. One payload satisfies both.
	payload, err := json.Marshal(map[string]any{
		"content": fmt.Sprintf("[%s] %s: %s", alert.Level, alert.Title, alert.Message),
		"text":    fmt.Sprintf("[%s] %s: %s", alert.Level, alert.Title, alert.Message),
		"alert":   alert,
	})
	if err != nil {
		return err
	}

	req, err := http.NewRequest(http.MethodPost, n.url, bytes.NewReader(payload))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")

	res, err := n.client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()

	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return fmt.Errorf("webhook returned %s", res.Status)
	}
	return nil
}
