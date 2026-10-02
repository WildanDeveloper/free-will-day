// Package database is the read side of the action log. The agent appends
// JSONL; this package parses it into typed records for the dashboard and the
// watchdog. No writes happen here, so the supervisor cannot corrupt the log.
package database

import (
	"bufio"
	"encoding/json"
	"os"
	"sort"
	"time"
)

// Record matches the TS ActionRecord contract in internal/logger/actions.ts.
// Unknown JSON fields are ignored, so either side can evolve independently.
type Record struct {
	TS          int64           `json:"ts"`
	Seq         int64           `json:"seq"`
	Type        string          `json:"type"`
	Thought     string          `json:"thought"`
	Tool        string          `json:"tool"`
	Input       json.RawMessage `json:"input"`
	Output      string          `json:"output"`
	OK          *bool           `json:"ok"`
	InputTokens int64           `json:"inputTokens"`
	OutputToken int64           `json:"outputTokens"`
	CostUSD     float64         `json:"costUsd"`
	HaltReason  string          `json:"haltReason"`
}

type State struct {
	Seq         int64   `json:"seq"`
	SpentUSD    float64 `json:"spentUsd"`
	StartedAt   int64   `json:"startedAt"`
	ActionCount int64   `json:"actionCount"`
}

// Store reads the action log and state file on demand.
type Store struct {
	actionsPath string
	statePath   string
	maxScan     int64
}

func NewStore(actionsPath, statePath string, maxScan int64) *Store {
	return &Store{actionsPath: actionsPath, statePath: statePath, maxScan: maxScan}
}

// Tail returns the last n records. Only the tail of the file is read, so cost
// stays flat as the log grows during a 24 hour run.
func (s *Store) Tail(n int) []Record {
	file, err := os.Open(s.actionsPath)
	if err != nil {
		return nil
	}
	defer file.Close()

	info, err := file.Stat()
	if err != nil {
		return nil
	}
	if s.maxScan > 0 && info.Size() > s.maxScan {
		if _, err := file.Seek(info.Size()-s.maxScan, 0); err != nil {
			return nil
		}
	}

	var out []Record
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 0, 1024*1024), 8*1024*1024)
	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}
		var rec Record
		if err := json.Unmarshal(line, &rec); err != nil {
			// Torn final line after a crash. Expected, not an error.
			continue
		}
		out = append(out, rec)
		if len(out) > n*4 {
			out = out[len(out)-n:]
		}
	}
	return out
}

// State returns the agent's checkpoint file.
func (s *Store) State() State {
	var st State
	raw, err := os.ReadFile(s.statePath)
	if err != nil {
		return State{}
	}
	_ = json.Unmarshal(raw, &st)
	return st
}

// LastActionTime reports the timestamp of the most recent record.
func (s *Store) LastActionTime() (time.Time, bool) {
	records := s.Tail(1)
	if len(records) == 0 {
		return time.Time{}, false
	}
	return time.UnixMilli(records[len(records)-1].TS), true
}

// Totals aggregates spend and counts across the whole log.
type Totals struct {
	CostUSD     float64            `json:"costUsd"`
	InputTokens int64              `json:"inputTokens"`
	OutputToken int64              `json:"outputTokens"`
	Actions     int64              `json:"actions"`
	Errors      int64              `json:"errors"`
	ToolCounts  map[string]int     `json:"toolCounts"`
	ByType      map[string]int     `json:"byType"`
	FirstTS     int64              `json:"firstTs"`
	LastTS      int64              `json:"lastTs"`
	CostByHour  map[string]float64 `json:"costByHour"`
}

func (s *Store) Totals() Totals {
	t := Totals{
		ToolCounts: map[string]int{},
		ByType:     map[string]int{},
		CostByHour: map[string]float64{},
	}
	for _, rec := range s.Tail(20000) {
		t.CostUSD += rec.CostUSD
		t.InputTokens += rec.InputTokens
		t.OutputToken += rec.OutputToken
		t.ByType[rec.Type]++
		if rec.CostUSD > 0 && rec.TS > 0 {
			hour := time.UnixMilli(rec.TS).Format("15:04")
			t.CostByHour[hour] += rec.CostUSD
		}
		if rec.Type == "action" {
			t.Actions++
			if rec.Tool != "" {
				t.ToolCounts[rec.Tool]++
			}
			if rec.OK != nil && !*rec.OK {
				t.Errors++
			}
		}
		if rec.TS > 0 {
			if t.FirstTS == 0 || rec.TS < t.FirstTS {
				t.FirstTS = rec.TS
			}
			if rec.TS > t.LastTS {
				t.LastTS = rec.TS
			}
		}
	}
	return t
}

// TopTools returns the most used tools, descending.
func (t Totals) TopTools(n int) []ToolCount {
	out := make([]ToolCount, 0, len(t.ToolCounts))
	for name, count := range t.ToolCounts {
		out = append(out, ToolCount{Name: name, Count: count})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Count != out[j].Count {
			return out[i].Count > out[j].Count
		}
		return out[i].Name < out[j].Name
	})
	if len(out) > n {
		out = out[:n]
	}
	return out
}

type ToolCount struct {
	Name  string `json:"name"`
	Count int    `json:"count"`
}

// RepeatedTools reports tools used many times in a row, the stuck-loop signal.
func RepeatedTools(records []Record, threshold int) []string {
	var out []string
	if len(records) < threshold {
		return out
	}
	// Look at the last 200 records.
	window := records
	if len(window) > 200 {
		window = window[len(window)-200:]
	}
	counts := map[string]int{}
	var order []string
	for _, rec := range window {
		if rec.Tool == "" {
			continue
		}
		if _, seen := counts[rec.Tool]; !seen {
			order = append(order, rec.Tool)
		}
		counts[rec.Tool]++
	}
	for _, name := range order {
		if counts[name] >= threshold {
			out = append(out, name)
		}
	}
	sort.Strings(out)
	return out
}
