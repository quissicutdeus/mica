// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// A tree with the three things that matter to /addons/: the public catalog, a demo
// catalog beside the demo bundle (which must keep behaving as it did), and the demo
// document the fallback hands out.
func testAssets() map[string]*asset {
	file := func(p, body string) *asset {
		return &asset{
			contentType:  contentType(p),
			cacheControl: cacheControl(p),
			identity:     encoded{body: []byte(body), etag: etagOf([]byte(body))},
		}
	}
	return map[string]*asset{
		"/index.html":                file("/index.html", "landing"),
		"/demo/index.html":           file("/demo/index.html", "demo"),
		"/demo/addons/catalog.json":  file("/demo/addons/catalog.json", `[{"id":"snek"}]`),
		"/addons/sdk-1/catalog.json": file("/addons/sdk-1/catalog.json", "[]\n"),
		"/addons/sdk-1/example.js":   file("/addons/sdk-1/example.js", "export {}"),
	}
}

func get(t *testing.T, path string, hdr ...string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, path, nil)
	for i := 0; i+1 < len(hdr); i += 2 {
		req.Header.Set(hdr[i], hdr[i+1])
	}
	rec := httptest.NewRecorder()
	handler(testAssets()).ServeHTTP(rec, req)
	return rec
}

func TestPublicCatalogServesJSONWithCORS(t *testing.T) {
	rec := get(t, "/addons/sdk-1/catalog.json")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if got := rec.Header().Get("Content-Type"); !strings.HasPrefix(got, "application/json") {
		t.Errorf("Content-Type = %q, want application/json", got)
	}
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "*" {
		t.Errorf("Access-Control-Allow-Origin = %q, want *", got)
	}
	if rec.Body.String() != "[]\n" {
		t.Errorf("body = %q, want an empty JSON array", rec.Body.String())
	}
}

func TestPublicBundleCarriesCORS(t *testing.T) {
	rec := get(t, "/addons/sdk-1/example.js")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "*" {
		t.Errorf("Access-Control-Allow-Origin = %q, want *", got)
	}
}

// The wildcard is all it may say: credentials and the preflight answers are what would turn
// a public read-only file into something broader.
func TestPublicAddonsSendNothingBroaderThanTheWildcard(t *testing.T) {
	for _, p := range []string{"/addons/sdk-1/catalog.json", "/addons/sdk-1/missing.js"} {
		h := get(t, p, "Origin", "https://cfx-nui-mica").Header()
		for _, name := range []string{
			"Access-Control-Allow-Credentials",
			"Access-Control-Allow-Methods",
			"Access-Control-Allow-Headers",
			"Access-Control-Expose-Headers",
		} {
			if got := h.Get(name); got != "" {
				t.Errorf("%s: %s = %q, want it unset", p, name, got)
			}
		}
	}
}

func TestMissUnderAddonsIs404NotTheHTMLFallback(t *testing.T) {
	for _, p := range []string{
		"/addons/sdk-1/nope.js",
		"/addons/sdk-2/catalog.json",
		"/addons/",
		"/addons",
		"/addons/sdk-1/",
	} {
		rec := get(t, p)
		if rec.Code != http.StatusNotFound {
			t.Errorf("%s: status = %d, want 404", p, rec.Code)
		}
		if strings.Contains(rec.Body.String(), "demo") {
			t.Errorf("%s: body served the demo document", p)
		}
	}
}

// A 404 under /addons/ still carries the header: a cross-origin fetch that missed should
// see a 404, not an opaque failure.
func TestMissUnderAddonsCarriesCORS(t *testing.T) {
	rec := get(t, "/addons/sdk-1/nope.js")
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "*" {
		t.Errorf("Access-Control-Allow-Origin = %q, want *", got)
	}
}

// Traversal is cleaned before routing, so a path that starts in /addons/ but resolves
// elsewhere is judged as where it lands, and one that lands in /addons/ is judged there.
func TestTraversalIsJudgedWhereItLands(t *testing.T) {
	if got := get(t, "/addons/../demo/addons/catalog.json").Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Errorf("a path that resolves into /demo/ got CORS %q", got)
	}
	if rec := get(t, "/demo/../addons/sdk-1/catalog.json"); rec.Code != http.StatusOK ||
		rec.Header().Get("Access-Control-Allow-Origin") != "*" {
		t.Errorf("a path that resolves into /addons/ = %d, CORS %q", rec.Code, rec.Header().Get("Access-Control-Allow-Origin"))
	}
}

// Everything the demo did before stays as it was: its catalog is served, without CORS, and
// a stray path under /demo/ still falls back to the phone.
func TestDemoBehaviourIsUnchanged(t *testing.T) {
	rec := get(t, "/demo/addons/catalog.json")
	if rec.Code != http.StatusOK {
		t.Fatalf("demo catalog status = %d, want 200", rec.Code)
	}
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Errorf("demo catalog Access-Control-Allow-Origin = %q, want it unset", got)
	}

	rec = get(t, "/demo/addons/not-a-bundle.js")
	if rec.Code != http.StatusOK || rec.Body.String() != "demo" {
		t.Errorf("stray demo path = %d %q, want the demo document", rec.Code, rec.Body.String())
	}

	if rec := get(t, "/some/deep/path"); rec.Code != http.StatusNotFound {
		t.Errorf("stray top-level path = %d, want 404", rec.Code)
	}
}

func TestConditionalRequestOnPublicCatalog(t *testing.T) {
	first := get(t, "/addons/sdk-1/catalog.json")
	rec := get(t, "/addons/sdk-1/catalog.json", "If-None-Match", first.Header().Get("ETag"))
	if rec.Code != http.StatusNotModified {
		t.Errorf("status = %d, want 304", rec.Code)
	}
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "*" {
		t.Errorf("304 Access-Control-Allow-Origin = %q, want *", got)
	}
}

// The image must not come up without a public catalog: every stock server's Store would
// fetch a 404 and show an empty list with nothing said.
func TestHasPublicCatalog(t *testing.T) {
	if !hasPublicCatalog(testAssets()) {
		t.Error("a tree carrying /addons/sdk-1/catalog.json was reported as having none")
	}

	without := testAssets()
	delete(without, "/addons/sdk-1/catalog.json")
	if hasPublicCatalog(without) {
		t.Error("a tree with no public catalog was reported as having one")
	}

	// The demo's catalog is not the public one.
	onlyDemo := map[string]*asset{"/demo/addons/catalog.json": testAssets()["/demo/addons/catalog.json"]}
	if hasPublicCatalog(onlyDemo) {
		t.Error("the demo catalog was reported as the public catalog")
	}
}
