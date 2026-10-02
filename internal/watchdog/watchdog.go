// Package watchdog enforces the stop conditions and watches for pathologies:
// cost overruns, idle agents, stuck loops, and a dead agent process. It is the
// second reader of the STOP file, so a halt still happens if the agent stops
// checking.
package watchdog

import (
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sort"
	"time"

	"freewillday/internal/config"
	"freewillday/internal/database"
)

type Watchdog struct {
	cfg    config.Config
	store  *database.Store
	logger *log.Logger

	startTime time.Time
	halted    bool
	haltWhy   string
}

func New(cfg config.Config, store *database.Store, logger *log.Logger) *Watchdog {
	return &Watchdog{
		cfg:       cfg,
		store:     store,
		logger:    logger,
		startTime: time.Now(),
	}
}

type Check struct {
	Halted       bool               `json:"halted"`
	Reason       string             `json:"reason"`
	StopFile     bool               `json:"stopFile"`
	BudgetUsed   float64            `json:"budgetUsed"`
	BudgetLimit  float64            `json:"budgetLimit"`
	OverBudget   bool               `json:"overBudget"`
	Idle         bool               `json:"idle"`
	IdleMinutes  float64            `json:"idleMinutes"`
	RepeatedTool []string           `json:"repeatedTools"`
	CostByHour   map[string]float64 `json:"costByHour"`
}

// CheckStop writes the STOP file. Idempotent.
func (w *Watchdog) CheckStop() {
	if _, err := os.Stat(w.cfg.StopFile); err == nil {
		return
	}
	if err := os.WriteFile(w.cfg.StopFile, []byte("halted by supervisor\n"), 0o644); err != nil {
		w.logger.Printf("watchdog: cannot write stop file: %v", err)
	}
}

func (w *Watchdog) Halted() (bool, string) { return w.halted, w.haltWhy }

// Run checks every interval until the agent halts.
func (w *Watchdog) Run(interval time.Duration, done <-chan struct{}) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		select {
		case <-done:
			return
		case <-ticker.C:
			w.once()
		}
	}
}

func (w *Watchdog) once() {
	check := w.Check()

	if check.StopFile {
		w.halt("STOP file present")
		w.CheckStop()
		return
	}
	if check.OverBudget {
		w.halt(fmt.Sprintf("budget exceeded: $%.4f of $%.2f", check.BudgetUsed, check.BudgetLimit))
		w.CheckStop()
		return
	}

	state := w.store.State()
	if state.StartedAt > 0 && w.cfg.RunDuration > 0 {
		elapsed := time.Since(time.UnixMilli(state.StartedAt))
		if elapsed >= w.cfg.RunDuration {
			w.halt(fmt.Sprintf("run duration reached after %s", elapsed.Round(time.Minute)))
			w.CheckStop()
			return
		}
	}

	if check.Idle {
		w.logger.Printf("watchdog: no actions for %.0f minutes", check.IdleMinutes)
	}
	if len(check.RepeatedTool) > 0 {
		w.logger.Printf("watchdog: possible stuck loop on %v", check.RepeatedTool)
	}
	if check.BudgetUsed > w.cfg.CostAlertUSD {
		w.logger.Printf("watchdog: spend $%.4f is above the alert threshold $%.2f",
			check.BudgetUsed, w.cfg.CostAlertUSD)
	}
}

func (w *Watchdog) halt(reason string) {
	if !w.halted {
		w.halted = true
		w.haltWhy = reason
		w.logger.Printf("watchdog: halting, %s", reason)
	}
}

func (w *Watchdog) Check() Check {
	totals := w.store.Totals()

	check := Check{
		BudgetUsed:  totals.CostUSD,
		BudgetLimit: w.cfg.MaxBudgetUSD,
		OverBudget:  totals.CostUSD >= w.cfg.MaxBudgetUSD,
		RepeatedTool: database.RepeatedTools(
			w.store.Tail(200), 40,
		),
		CostByHour: totals.CostByHour,
	}

	if _, err := os.Stat(w.cfg.StopFile); err == nil {
		check.StopFile = true
	}
	if w.halted {
		check.Halted = true
		check.Reason = w.haltWhy
	}

	if last, ok := w.store.LastActionTime(); ok {
		idle := time.Since(last)
		check.IdleMinutes = idle.Minutes()
		check.Idle = idle > time.Duration(w.cfg.IdleAlertMins)*time.Minute
	}

	return check
}

// LatestScreenshot returns the newest screenshot path, used by the dashboard.
func LatestScreenshot(dir string) string {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return ""
	}
	var names []string
	for _, e := range entries {
		if !e.IsDir() && filepath.Ext(e.Name()) == ".png" {
			names = append(names, e.Name())
		}
	}
	if len(names) == 0 {
		return ""
	}
	sort.Strings(names)
	return filepath.Join(dir, names[len(names)-1])
}
