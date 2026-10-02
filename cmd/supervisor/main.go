// Command supervisor is the Go half of Free Will Day. It reads the action log
// written by the agent, serves the dashboard, and halts the run when a stop
// condition trips. It never writes to actions.jsonl.
package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"freewillday/internal/alerts"
	"freewillday/internal/auth"
	"freewillday/internal/config"
	"freewillday/internal/dashboard"
	"freewillday/internal/database"
	"freewillday/internal/watchdog"
)

func main() {
	logger := log.New(os.Stderr, "[supervisor] ", log.LstdFlags)

	cfg, err := config.Load()
	if err != nil {
		logger.Fatalf("config: %v", err)
	}

	for _, dir := range []string{cfg.LogsDir, filepath.Join(cfg.LogsDir, "screenshots")} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			logger.Fatalf("mkdir %s: %v", dir, err)
		}
	}

	store := database.NewStore(cfg.ActionsFile, cfg.StateFile, 4<<20)
	notify := alerts.New(logger)
	guard := watchdog.New(cfg, store, logger, notify)

	server, err := dashboard.NewServer(cfg, store, guard)
	if err != nil {
		logger.Fatalf("dashboard: %v", err)
	}

	middleware := auth.NewMiddleware(cfg.BasicAuthUser, cfg.BasicAuthPass, cfg.BearerToken)
	if !middleware.Enabled() {
		logger.Print("no dashboard credentials configured; relying on loopback + SSH tunnel")
	}

	handler := middleware.Wrap(server.Routes())

	httpServer := &http.Server{
		Addr:              cfg.Addr,
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       60 * time.Second,
	}

	done := make(chan struct{})
	go guard.Run(20*time.Second, done)

	go func() {
		logger.Printf("dashboard on http://%s (auth=%v)", cfg.Addr, middleware.Enabled())
		if err := httpServer.ListenAndServe(); err != nil &&
			!errors.Is(err, http.ErrServerClosed) {
			logger.Fatalf("listen: %v", err)
		}
	}()

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	<-sig
	logger.Print("shutting down")
	close(done)

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = httpServer.Shutdown(shutdownCtx)

	if halted, reason := guard.Halted(); halted {
		logger.Printf("run ended: %s", reason)
	} else {
		logger.Print("run ended: supervisor stopped")
		notify.Notify(alerts.LevelInfo, "supervisor stopped",
			"The supervisor shut down before a stop condition tripped.", "halt")
	}
}
