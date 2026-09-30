package certs

import (
	"crypto/tls"
	"crypto/x509"
	"encoding/pem"
	"os"
	"path/filepath"
	"testing"
)

func TestGenerateSelfTrustedCertificate(t *testing.T) {
	dir := t.TempDir()
	cert, key := filepath.Join(dir, "cert.pem"), filepath.Join(dir, "key.pem")
	if err := Generate(cert, key, []string{"10.24.20.254", "gateway.local"}); err != nil {
		t.Fatal(err)
	}
	if _, err := tls.LoadX509KeyPair(cert, key); err != nil {
		t.Fatal(err)
	}
	info, _ := os.Stat(key)
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("key mode %v", info.Mode())
	}
	data, _ := os.ReadFile(cert)
	block, _ := pem.Decode(data)
	parsed, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		t.Fatal(err)
	}
	pool := x509.NewCertPool()
	pool.AddCert(parsed)
	if _, err := parsed.Verify(x509.VerifyOptions{Roots: pool}); err != nil {
		t.Fatalf("certificate does not verify against itself: %v", err)
	}
	fp, err := Fingerprint(cert)
	if err != nil || len(fp) != 95 {
		t.Fatalf("fingerprint %q %v", fp, err)
	}
}
