// Package auth provides HTTP authentication for the dashboard. The dashboard
// binds to loopback and is read through an SSH tunnel, so this is defense in
// depth rather than the primary control.
package auth

import (
	"crypto/subtle"
	"net/http"
	"strings"
)

type Middleware struct {
	User     string
	Password string
	Token    string
}

func NewMiddleware(user, password, token string) *Middleware {
	return &Middleware{User: user, Password: password, Token: token}
}

// Enabled reports whether any credential is configured. With none configured
// the dashboard stays open, which is acceptable only on loopback.
func (m *Middleware) Enabled() bool {
	return m.User != "" || m.Token != ""
}

func (m *Middleware) Wrap(next http.Handler) http.Handler {
	if !m.Enabled() {
		return next
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if m.check(r) {
			next.ServeHTTP(w, r)
			return
		}
		w.Header().Set("WWW-Authenticate", `Basic realm="freewillday", charset="UTF-8"`)
		http.Error(w, "unauthorized", http.StatusUnauthorized)
	})
}

func (m *Middleware) check(r *http.Request) bool {
	header := r.Header.Get("Authorization")
	if header == "" {
		return false
	}

	// Bearer token takes precedence: it is the easier credential for a script.
	if m.Token != "" {
		if constantEqual(header, "Bearer "+m.Token) {
			return true
		}
	}

	if m.User != "" {
		user, pass, ok := parseBasic(header)
		if ok && constantEqual(user, m.User) && constantEqual(pass, m.Password) {
			return true
		}
	}
	return false
}

func parseBasic(header string) (string, string, bool) {
	const prefix = "Basic "
	if !strings.HasPrefix(header, prefix) {
		return "", "", false
	}
	decoded, err := decodeBase64(strings.TrimPrefix(header, prefix))
	if err != nil {
		return "", "", false
	}
	user, pass, found := strings.Cut(string(decoded), ":")
	if !found {
		return "", "", false
	}
	return user, pass, true
}

// constantEqual avoids leaking length and prefix through timing.
func constantEqual(a, b string) bool {
	return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}
