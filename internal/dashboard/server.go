// Package dashboard renders the monitoring page and serves the raw artifacts.
// The page is regenerated from the action log on every request and refreshed
// by the browser, so there is no server-side state and no SSE dependency.
package dashboard

import (
	"encoding/json"
	"fmt"
	"html/template"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"freewillday/internal/config"
	"freewillday/internal/database"
	"freewillday/internal/watchdog"
)

type View struct {
	RefreshSeconds int
	Halted         bool
	Reason         string
	Elapsed        string
	Duration       string
	Cost           string
	BudgetCap      string
	Actions        int64
	Errors         int64
	Tokens         string
	InputTokens    string
	OutputTokens   string
	IdleMinutes    string
	TopTools       []database.ToolCount
	RepeatedTools  []string
	Journal        string
	Screenshot     string
	RecentActions  []ActionRow
}

// ActionRow is one row of the recent actions table.
type ActionRow struct {
	Time   string
	Tool   string
	Output string
	OK     bool
}

type Server struct {
	cfg     config.Config
	store   *database.Store
	guard   *watchdog.Watchdog
	tmpl    *template.Template
	started time.Time
}

func NewServer(cfg config.Config, store *database.Store, guard *watchdog.Watchdog) (*Server, error) {
	// The template lives in web/templates so it stays editable without a
	// rebuild. Parsed once at startup; re-parsed on SIGHUP.
	path := filepath.Join(cfg.TemplateDir, "dashboard.html")
	tmpl, err := template.ParseFiles(path)
	if err != nil {
		return nil, fmt.Errorf("parse dashboard template at %s: %w", path, err)
	}
	return &Server{
		cfg:     cfg,
		store:   store,
		guard:   guard,
		tmpl:    tmpl,
		started: time.Now(),
	}, nil
}

func (s *Server) Routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/", s.handleIndex)
	mux.HandleFunc("/stop", s.handleStop)
	mux.HandleFunc("/screenshot", s.handleScreenshot)
	mux.HandleFunc("/api/log", s.serveRaw(s.cfg.ActionsFile))
	mux.HandleFunc("/api/journal", s.serveRaw(s.cfg.JournalFile))
	mux.HandleFunc("/api/state", s.serveRaw(s.cfg.StateFile))
	mux.HandleFunc("/api/summary", s.handleSummary)
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
	return s.originGuard(mux)
}

// originGuard rejects cross-site form posts, so a random page cannot hit /stop.
func (s *Server) originGuard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost && s.cfg.AllowedOrigin != "" {
			if got := r.Header.Get("Origin"); got != s.cfg.AllowedOrigin {
				http.Error(w, "forbidden origin", http.StatusForbidden)
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) handleIndex(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/" {
		http.NotFound(w, r)
		return
	}
	view := s.buildView()
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	if err := s.tmpl.Execute(w, view); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}

func (s *Server) buildView() View {
	totals := s.store.Totals()
	state := s.store.State()
	check := s.guard.Check()

	elapsed := time.Since(s.started).Round(time.Second)
	var duration time.Duration = s.cfg.RunDuration
	if state.StartedAt > 0 && s.cfg.RunDuration > 0 {
		remaining := s.cfg.RunDuration - time.Since(time.UnixMilli(state.StartedAt))
		if remaining < 0 {
			remaining = 0
		}
		elapsed = time.Since(time.UnixMilli(state.StartedAt)).Round(time.Second)
		_ = remaining
	}

	var rows []ActionRow
	for _, rec := range s.store.Tail(40) {
		if rec.Type != "action" {
			continue
		}
		ok := rec.OK != nil && *rec.OK
		rows = append(rows, ActionRow{
			Time:   time.UnixMilli(rec.TS).Format("15:04:05"),
			Tool:   rec.Tool,
			Output: firstLines(rec.Output, 220),
			OK:     ok,
		})
		if len(rows) >= 25 {
			break
		}
	}

	view := View{
		RefreshSeconds: 5,
		Halted:         check.Halted,
		Reason:         check.Reason,
		Elapsed:        shortDuration(elapsed),
		Duration:       shortDuration(duration),
		Cost:           fmt.Sprintf("%.4f", totals.CostUSD),
		BudgetCap:      fmt.Sprintf("%.2f", s.cfg.MaxBudgetUSD),
		Actions:        totals.Actions,
		Errors:         totals.Errors,
		Tokens:         compactInt(totals.InputTokens + totals.OutputToken),
		InputTokens:    compactInt(totals.InputTokens),
		OutputTokens:   compactInt(totals.OutputToken),
		IdleMinutes:    fmt.Sprintf("%.1f", check.IdleMinutes),
		TopTools:       totals.TopTools(8),
		RepeatedTools:  check.RepeatedTool,
		Journal:        firstLines(readTail(s.cfg.JournalFile, 6000), 4000),
		Screenshot:     watchdog.LatestScreenshot(filepath.Join(s.cfg.LogsDir, "screenshots")),
		RecentActions:  rows,
	}
	return view
}

func (s *Server) handleStop(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}
	// A second reader of the STOP file, independent of the agent process.
	if err := os.WriteFile(s.cfg.StopFile, []byte("halted from dashboard\n"), 0o644); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	http.Redirect(w, r, "/", http.StatusSeeOther)
}

func (s *Server) handleScreenshot(w http.ResponseWriter, r *http.Request) {
	latest := watchdog.LatestScreenshot(filepath.Join(s.cfg.LogsDir, "screenshots"))
	if latest == "" {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("Cache-Control", "no-store")
	http.ServeFile(w, r, latest)
}

func (s *Server) serveRaw(path string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		data, err := os.ReadFile(path)
		if err != nil {
			http.Error(w, "not available", http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		_, _ = w.Write(data)
	}
}

func (s *Server) handleSummary(w http.ResponseWriter, r *http.Request) {
	totals := s.store.Totals()
	w.Header().Set("Content-Type", "application/json")
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	_ = enc.Encode(map[string]any{
		"totals": totals,
		"state":  s.store.State(),
		"check":  s.guard.Check(),
	})
}

func readTail(path string, max int) string {
	data, err := os.ReadFile(path)
	if err != nil {
		return "no journal yet"
	}
	text := string(data)
	if len(text) > max {
		text = text[len(text)-max:]
	}
	return text
}

func firstLines(text string, max int) string {
	if text == "" {
		return ""
	}
	if len(text) <= max {
		return text
	}
	return "..." + text[len(text)-max:]
}

func shortDuration(d time.Duration) string {
	if d <= 0 {
		return "0s"
	}
	hours := int(d.Hours())
	minutes := int(d.Minutes()) % 60
	if hours > 0 {
		return fmt.Sprintf("%dh%02dm", hours, minutes)
	}
	return fmt.Sprintf("%dm%02ds", minutes, int(d.Seconds())%60)
}

func compactInt(n int64) string {
	if n < 1000 {
		return fmt.Sprintf("%d", n)
	}
	if n < 1_000_000 {
		return fmt.Sprintf("%.1fk", float64(n)/1000)
	}
	return fmt.Sprintf("%.2fM", float64(n)/1_000_000)
}

// TrimSpaceLines is used by tests to normalise journal tails.
func TrimSpaceLines(s string) string {
	return strings.TrimSpace(s)
}
