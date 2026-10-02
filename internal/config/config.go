/**
 * Supervisor configuration. Mirrors the agent's environment so both processes
 * agree on paths, budget, and duration without a shared config file.
 */

package config

import (
	"os"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	Addr          string
	WorkspaceDir  string
	MemoryDir     string
	LogsDir       string
	StopFile      string
	ActionsFile   string
	JournalFile   string
	StateFile     string
	TemplateDir   string
	RunDuration   time.Duration
	MaxBudgetUSD  float64
	BasicAuthUser string
	BasicAuthPass string
	BearerToken   string
	AllowedOrigin string
	IdleAlertMins int
	CostAlertUSD  float64
}

func env(key, fallback string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return fallback
}

func envFloat(key string, fallback float64) float64 {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		if f, err := strconv.ParseFloat(v, 64); err == nil {
			return f
		}
	}
	return fallback
}

func envInt(key string, fallback int) int {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		if i, err := strconv.Atoi(v); err == nil {
			return i
		}
	}
	return fallback
}

// ParseDuration accepts Go durations plus a bare number of hours.
func ParseDuration(raw string) (time.Duration, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return 0, nil
	}
	if h, err := strconv.ParseFloat(raw, 64); err == nil {
		return time.Duration(h * float64(time.Hour)), nil
	}
	return time.ParseDuration(raw)
}

func Load() (Config, error) {
	workspace := env("WORKSPACE_DIR", "/workspace")
	memory := env("MEMORY_DIR", "/memory")
	logs := env("LOGS_DIR", "/logs")

	runDuration, err := ParseDuration(env("RUN_DURATION", "24h"))
	if err != nil {
		return Config{}, err
	}

	return Config{
		Addr:          env("SUPERVISOR_ADDR", "127.0.0.1:8080"),
		WorkspaceDir:  workspace,
		MemoryDir:     memory,
		LogsDir:       logs,
		StopFile:      env("STOP_FILE", "/STOP"),
		ActionsFile:   env("ACTIONS_FILE", logs+"/actions.jsonl"),
		JournalFile:   env("JOURNAL_FILE", memory+"/journal.md"),
		StateFile:     env("STATE_FILE", memory+"/state.json"),
		TemplateDir:   env("TEMPLATE_DIR", "web/templates"),
		RunDuration:   runDuration,
		MaxBudgetUSD:  envFloat("MAX_BUDGET_USD", 5),
		BasicAuthUser: os.Getenv("DASHBOARD_USER"),
		BasicAuthPass: os.Getenv("DASHBOARD_PASSWORD"),
		BearerToken:   os.Getenv("DASHBOARD_TOKEN"),
		AllowedOrigin: env("ALLOWED_ORIGIN", ""),
		IdleAlertMins: envInt("IDLE_ALERT_MINUTES", 15),
		CostAlertUSD:  envFloat("COST_ALERT_USD", 3),
	}, nil
}
