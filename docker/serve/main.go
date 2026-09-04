// A static file server for the micaOS NUI bundle, and nothing else.
//
// The web root is dist/web as Vite emits it: a non-hashed index.html, a
// non-hashed mica.svg from web/public/, and content-hashed everything else
// under assets/. That split is the only reason there are two cache policies
// here -- the hashed files can be cached for a year, the other two cannot be
// cached at all.
//
// The whole tree is read into memory at startup. It is a few megabytes, and it
// buys three things: an ETag per encoding for free, no per-request stat, and no
// path traversal to reason about -- every lookup hits a map built by walking
// the tree, so a path that is not a real file simply is not a key.
package main

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	// Go resolves the local zone from $TZ and falls back to /etc/localtime --
	// and a scratch image has neither a zone database nor an /etc/localtime, so
	// without this every zone name resolves to UTC in silence. The blank import
	// compiles the IANA database into the binary (~450KB), which is what makes
	// $TZ work here at all without shipping /usr/share/zoneinfo.
	//
	// Scope note: this moves the *server log* timestamps and nothing else. The
	// phone's clock and every message timestamp are formatted in the browser
	// from the viewer's own system zone, so a visitor in Berlin sees Berlin
	// time regardless of what this container is set to.
	_ "time/tzdata"
)

const root = "/www"

// Ours rather than mime.TypeByExtension, because the stdlib table has no .woff2
// and compensates by reading /etc/mime.types at init -- a file that does not
// exist in a scratch image. web/src/main.ts imports four weights of
// @fontsource/roboto, so getting this wrong means ~30 fonts served as
// application/octet-stream.
var mimeByExt = map[string]string{
	".html": "text/html; charset=utf-8",
	".js":   "text/javascript; charset=utf-8",
	".mjs":  "text/javascript; charset=utf-8",
	".css":  "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".map":  "application/json; charset=utf-8",
	".txt":  "text/plain; charset=utf-8",

	".svg":  "image/svg+xml",
	".png":  "image/png",
	".jpg":  "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".avif": "image/avif",
	".gif":  "image/gif",
	".ico":  "image/vnd.microsoft.icon",

	".woff2": "font/woff2",
	".woff":  "font/woff",
	".ttf":   "font/ttf",

	".mp3":  "audio/mpeg",
	".ogg":  "audio/ogg",
	".mp4":  "video/mp4",
	".webm": "video/webm",

	".wasm":        "application/wasm",
	".webmanifest": "application/manifest+json",
}

type encoded struct {
	body []byte
	etag string
}

type asset struct {
	contentType  string
	cacheControl string
	identity     encoded
	br           *encoded
	gz           *encoded
}

func main() {
	port := envPort()

	// Same binary, second mode, so HEALTHCHECK has something to exec in an
	// image with no shell and no curl.
	if len(os.Args) > 1 && (os.Args[1] == "-health" || os.Args[1] == "--health") {
		os.Exit(health(port))
	}

	zone := localZone()

	assets, err := load(root)
	if err != nil {
		log.Fatalf("load %s: %v", root, err)
	}
	if _, ok := assets["/index.html"]; !ok {
		log.Fatalf("%s/index.html is missing; the web stage produced no build", root)
	}
	log.Printf("mica-serve: %d files from %s on :%d, TZ=%s (%s)",
		len(assets), root, port, zone, time.Now().In(zone).Format("2006-01-02 15:04:05 MST"))

	srv := &http.Server{
		Addr:              fmt.Sprintf("0.0.0.0:%d", port),
		Handler:           handler(assets),
		ReadHeaderTimeout: 5 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       60 * time.Second,
	}

	// Why this exists: this process is PID 1. The kernel does not apply default
	// signal dispositions to PID 1 -- a signal with no installed handler is not
	// merely defaulted, it is not delivered. Without this, `docker stop` does
	// nothing, Docker waits out its ten-second grace period, and every stop is
	// a SIGKILL with responses cut mid-body.
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()
	go func() {
		<-ctx.Done()
		log.Print("mica-serve: shutting down")
		sh, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(sh)
	}()

	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}

// Resolve and validate $TZ.
//
// Go's runtime already does this at init; the point of doing it again is the
// error path. An unknown zone name leaves time.Local silently set to UTC, and
// "the timestamps are wrong" is a miserable thing to debug from nothing. Here
// it is one warning line at startup.
//
// Assigning time.Local is safe only because this runs before any goroutine that
// reads it -- the server is not listening yet.
func localZone() *time.Location {
	name := os.Getenv("TZ")
	if name == "" {
		// TZ genuinely unset (Go tried /etc/localtime and fell back to UTC), or
		// set to the empty string, which means UTC by definition. Either way
		// time.Local already holds the right answer.
		return time.Local
	}
	loc, err := time.LoadLocation(name)
	if err != nil {
		// Deliberately not fatal. A typo in TZ should not take a demo offline
		// over the formatting of log lines.
		log.Printf("mica-serve: TZ=%q is not a known zone (%v); staying on %s", name, err, time.Local)
		return time.Local
	}
	time.Local = loc
	return loc
}

func load(dir string) (map[string]*asset, error) {
	out := map[string]*asset{}
	at := func(p string) *asset {
		if a, ok := out[p]; ok {
			return a
		}
		a := &asset{}
		out[p] = a
		return a
	}

	err := filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		rel, err := filepath.Rel(dir, p)
		if err != nil {
			return err
		}
		body, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		urlPath := "/" + filepath.ToSlash(rel)

		// A per-variant ETag, hashed from that variant's own bytes. Sharing one
		// ETag across encodings is how a shared cache ends up handing a brotli
		// body to a client that never asked for one.
		v := encoded{body: body, etag: etagOf(body)}

		switch {
		case strings.HasSuffix(urlPath, ".br"):
			at(strings.TrimSuffix(urlPath, ".br")).br = &v
		case strings.HasSuffix(urlPath, ".gz"):
			at(strings.TrimSuffix(urlPath, ".gz")).gz = &v
		default:
			a := at(urlPath)
			a.identity = v
			a.contentType = contentType(urlPath)
			a.cacheControl = cacheControl(urlPath)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}

	// Reconstruct the identity copies the build stage deleted.
	//
	// Anything that got a .gz has its original removed from the image: shipping
	// both is ~760KB of duplicate bytes whose only job is serving the rare client
	// that sends no Accept-Encoding at all. Inflating here costs a few
	// milliseconds once, at startup, and keeps them out of the layer. Files too
	// small to be worth compressing were never deleted and skip this entirely.
	for p, a := range out {
		if a.identity.body != nil {
			continue
		}
		if a.gz == nil {
			// A sidecar whose base file vanished, with no .gz to rebuild it from.
			delete(out, p)
			continue
		}
		body, err := gunzip(a.gz.body)
		if err != nil {
			return nil, fmt.Errorf("inflate %s.gz: %w", p, err)
		}
		a.identity = encoded{body: body, etag: etagOf(body)}
		a.contentType = contentType(p)
		a.cacheControl = cacheControl(p)
	}
	return out, nil
}

func gunzip(b []byte) ([]byte, error) {
	zr, err := gzip.NewReader(bytes.NewReader(b))
	if err != nil {
		return nil, err
	}
	defer zr.Close()
	return io.ReadAll(zr)
}

func handler(assets map[string]*asset) http.Handler {
	index := assets["/index.html"]

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		if r.URL.Path == "/healthz" {
			w.Header().Set("Cache-Control", "no-store")
			w.Header().Set("Content-Type", "text/plain; charset=utf-8")
			_, _ = io.WriteString(w, "ok\n")
			return
		}

		p := path.Clean("/" + r.URL.Path)
		if strings.HasSuffix(r.URL.Path, "/") {
			p = path.Join(p, "index.html")
		}

		a, ok := assets[p]
		if !ok {
			// Not an SPA rewrite: navigation in web/src/shell/state/navigation.ts
			// is in-memory Svelte stores and there is no History API use anywhere
			// in web/src, so no URL but / is ever requested. This is here so a
			// stray path renders the phone rather than an empty 404 -- and it is
			// safe only because a miss under /assets/ 404s first. Masking a
			// genuinely missing chunk with an HTML 200 is how you get an
			// unreadable "unexpected token '<'" instead of a 404.
			if strings.HasPrefix(p, "/assets/") {
				http.NotFound(w, r)
				return
			}
			a = index
		}

		h := w.Header()
		h.Set("Content-Type", a.contentType)
		h.Set("Cache-Control", a.cacheControl)
		h.Set("Vary", "Accept-Encoding")
		h.Set("X-Content-Type-Options", "nosniff")
		// The mock data points at third-party image hosts (robohash, dicebear,
		// unsplash), so a visitor's browser requests them and sends this page's URL
		// along as the Referer. Trim that to the origin for cross-site requests.
		// Cannot affect rendering, unlike a CSP, which this deliberately is not:
		// the app's inline styles and those image hosts make a correct policy
		// something to verify in a browser, not to add blind before a launch.
		h.Set("Referrer-Policy", "strict-origin-when-cross-origin")

		v := a.identity
		ae := r.Header.Get("Accept-Encoding")
		switch {
		case a.br != nil && accepts(ae, "br"):
			v = *a.br
			h.Set("Content-Encoding", "br")
		case a.gz != nil && accepts(ae, "gzip"):
			v = *a.gz
			h.Set("Content-Encoding", "gzip")
		}
		h.Set("ETag", v.etag)

		// ServeContent refuses to set Content-Length whenever Content-Encoding is
		// present -- it has no way to know the reader it was handed is already in
		// that encoding. Ours is, and its exact size is right here, so declare it
		// rather than let every compressed response fall back to chunked framing
		// with no length for the browser to size a progress bar against.
		//
		// Gated on Range being absent: a 206 must declare the length of the
		// *range*, which ServeContent works out for itself.
		if h.Get("Content-Encoding") != "" && r.Header.Get("Range") == "" {
			h.Set("Content-Length", strconv.Itoa(len(v.body)))
		}

		// Zero modtime and an empty name: ServeContent then skips Last-Modified
		// and skips sniffing (Content-Type is already set), while still handling
		// Range and If-None-Match against our ETag.
		http.ServeContent(w, r, "", time.Time{}, bytes.NewReader(v.body))
	})
}

// Vite emits assets/[name]-[hash][ext], so the name changes whenever the bytes
// do -- a year of immutable caching cannot serve a stale file, and `immutable`
// also suppresses the revalidation a reload would otherwise force. index.html is
// the document that *names* those hashed files, so caching it is precisely how
// you pin a client to a dead build.
func cacheControl(p string) string {
	if strings.HasPrefix(p, "/assets/") {
		return "public, max-age=31536000, immutable"
	}
	return "no-cache"
}

func contentType(p string) string {
	if t, ok := mimeByExt[strings.ToLower(path.Ext(p))]; ok {
		return t
	}
	return "application/octet-stream"
}

func accepts(header, coding string) bool {
	for _, part := range strings.Split(header, ",") {
		tok := strings.TrimSpace(part)
		if i := strings.IndexByte(tok, ';'); i >= 0 {
			params := tok[i:]
			// q=0 is an explicit refusal; q=0.5 is not.
			if strings.Contains(params, "q=0") && !strings.Contains(params, "q=0.") {
				continue
			}
			tok = strings.TrimSpace(tok[:i])
		}
		if strings.EqualFold(tok, coding) {
			return true
		}
	}
	return false
}

func etagOf(b []byte) string {
	sum := sha256.Sum256(b)
	return `"` + hex.EncodeToString(sum[:16]) + `"`
}

func envPort() int {
	p := 8080
	if v := os.Getenv("PORT"); v != "" {
		if _, err := fmt.Sscanf(v, "%d", &p); err != nil || p <= 0 || p > 65535 {
			log.Fatalf("PORT=%q is not a valid port", v)
		}
	}
	return p
}

// Hand-rolled on net rather than net/http: the probe is one request to a socket
// on this container's own loopback, and it must never resolve a name --
// "localhost" would drag /etc/hosts and the resolver config into an image that
// otherwise needs neither.
func health(port int) int {
	c, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", port), 2*time.Second)
	if err != nil {
		return 1
	}
	defer c.Close()
	_ = c.SetDeadline(time.Now().Add(2 * time.Second))
	if _, err := io.WriteString(c, "GET /healthz HTTP/1.0\r\nHost: h\r\n\r\n"); err != nil {
		return 1
	}
	buf := make([]byte, 12)
	if _, err := io.ReadFull(c, buf); err != nil {
		return 1
	}
	if bytes.HasSuffix(buf, []byte(" 200")) {
		return 0
	}
	return 1
}
