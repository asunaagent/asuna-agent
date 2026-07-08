#!/usr/bin/env python3
"""PearlFortune TLS Proxy v7 - Threading, single port 443
Auto-detect HTTP (enrollment) vs TLS (mining) via MSG_PEEK.
Uses makefile() for line reading on SSLSocket.
"""
import ssl, json, logging, os, sys, time, socket, threading
from datetime import datetime, timedelta
from cryptography import x509
from cryptography.x509.oid import NameOID
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec

PROXY_HOST = "0.0.0.0"
PROXY_PORT = 443
POOL_HOST = "127.0.0.1"
POOL_PORT = 5555
CERT_DIR = "/home/ubuntu/pool/certs"
LOG_FILE = "/home/ubuntu/proxy.log"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.FileHandler(LOG_FILE, mode="a"),
        logging.StreamHandler(sys.stdout),
    ],
)
logger = logging.getLogger("proxy")


class CA:
    count = 0
    enrollments = 0

    def ensure_certs(self):
        os.makedirs(CERT_DIR, exist_ok=True)
        ca_k = f"{CERT_DIR}/ca-key.pem"
        ca_c = f"{CERT_DIR}/ca-cert.pem"
        srv_k = f"{CERT_DIR}/server-key.pem"
        srv_c = f"{CERT_DIR}/server-cert.pem"
        if os.path.exists(ca_c) and os.path.exists(srv_c):
            return ca_c, ca_k, srv_c, srv_k

        logger.info("Generating certs...")
        ca_key = ec.generate_private_key(ec.SECP256R1())
        cn = x509.Name([
            x509.NameAttribute(NameOID.ORGANIZATION_NAME, "PearlFortune"),
            x509.NameAttribute(NameOID.COMMON_NAME, "Worker Local CA"),
        ])
        ca_cert = (
            x509.CertificateBuilder()
            .subject_name(cn)
            .issuer_name(cn)
            .public_key(ca_key.public_key())
            .serial_number(x509.random_serial_number())
            .not_valid_before(datetime.now())
            .not_valid_after(datetime.now() + timedelta(days=3650))
            .add_extension(
                x509.BasicConstraints(ca=True, path_length=None), critical=True
            )
            .sign(ca_key, hashes.SHA256())
        )
        with open(ca_k, "wb") as f:
            f.write(
                ca_key.private_bytes(
                    serialization.Encoding.PEM,
                    serialization.PrivateFormat.PKCS8,
                    serialization.NoEncryption(),
                )
            )
        with open(ca_c, "wb") as f:
            f.write(ca_cert.public_bytes(serialization.Encoding.PEM))

        srv_key = ec.generate_private_key(ec.SECP256R1())
        srv_cert = (
            x509.CertificateBuilder()
            .subject_name(
                x509.Name([
                    x509.NameAttribute(NameOID.ORGANIZATION_NAME, "PearlFortune"),
                    x509.NameAttribute(
                        NameOID.COMMON_NAME, "worker-proxy.local"
                    ),
                ])
            )
            .issuer_name(cn)
            .public_key(srv_key.public_key())
            .serial_number(x509.random_serial_number())
            .not_valid_before(datetime.now())
            .not_valid_after(datetime.now() + timedelta(days=3650))
            .add_extension(
                x509.SubjectAlternativeName([x509.DNSName("localhost")]),
                critical=False,
            )
            .sign(ca_key, hashes.SHA256())
        )
        with open(srv_k, "wb") as f:
            f.write(
                srv_key.private_bytes(
                    serialization.Encoding.PEM,
                    serialization.PrivateFormat.PKCS8,
                    serialization.NoEncryption(),
                )
            )
        with open(srv_c, "wb") as f:
            f.write(srv_cert.public_bytes(serialization.Encoding.PEM))

        logger.info(f"Certs in {CERT_DIR}")
        return ca_c, ca_k, srv_c, srv_k

    def issue_client(self):
        with open(f"{CERT_DIR}/ca-key.pem", "rb") as f:
            ca_key = serialization.load_pem_private_key(f.read(), password=None)
        with open(f"{CERT_DIR}/ca-cert.pem", "rb") as f:
            ca_cert = x509.load_pem_x509_certificate(f.read())

        c_key = ec.generate_private_key(ec.SECP256R1())
        c_cert = (
            x509.CertificateBuilder()
            .subject_name(
                x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "miner")])
            )
            .issuer_name(ca_cert.subject)
            .public_key(c_key.public_key())
            .serial_number(x509.random_serial_number())
            .not_valid_before(datetime.now())
            .not_valid_after(datetime.now() + timedelta(days=365))
            .add_extension(
                x509.ExtendedKeyUsage(
                    [x509.oid.ExtendedKeyUsageOID.CLIENT_AUTH]
                ),
                critical=False,
            )
            .sign(ca_key, hashes.SHA256())
        )
        return (
            c_cert.public_bytes(serialization.Encoding.PEM).decode(),
            c_key.private_bytes(
                serialization.Encoding.PEM,
                serialization.PrivateFormat.PKCS8,
                serialization.NoEncryption(),
            ).decode(),
        )


ca = CA()
ssl_ctx = None


def recv_line(sock, timeout=5):
    """Read a line from raw socket."""
    sock.settimeout(timeout)
    buf = b""
    while True:
        try:
            ch = sock.recv(1)
            if not ch:
                return buf
            buf += ch
            if ch == b"\n":
                return buf
        except socket.timeout:
            return buf


def handle_client(sock, addr):
    """Auto-detect HTTP vs TLS via MSG_PEEK."""
    try:
        sock.settimeout(5)
        first = sock.recv(1, socket.MSG_PEEK)
        if not first:
            sock.close()
            return
        if first[0] == 0x16:
            # TLS ClientHello
            handle_tls(sock, addr)
        else:
            # HTTP
            first_line = recv_line(sock, timeout=5)
            if first_line.startswith(b"POST /enroll/client-cert"):
                handle_http(sock, addr, first_line)
            else:
                sock.close()
    except Exception as e:
        logger.error(f"[{addr}] {e}")
        try:
            sock.close()
        except Exception:
            pass


def handle_http(sock, addr, first_line):
    """HTTP POST /enroll/client-cert - issue client cert."""
    ca.enrollments += 1
    # Read remaining headers until blank line
    while True:
        line = recv_line(sock, timeout=5)
        if not line or line.strip() == b"":
            break

    cert_pem, key_pem = ca.issue_client()
    body = json.dumps({
        "certificate": cert_pem,
        "key": key_pem,
        "expires": int(time.time()) + 86400 * 365,
    })
    resp = (
        f"HTTP/1.1 200 OK\r\n"
        f"Content-Type: application/json\r\n"
        f"Content-Length: {len(body)}\r\n"
        f"Connection: close\r\n\r\n{body}"
    )
    sock.sendall(resp.encode())
    sock.close()
    logger.info(f"Enrollment #{ca.enrollments} from {addr}")


def handle_tls(sock, addr):
    """TLS connection -> relay stratum to private pool."""
    ca.count += 1
    cid = ca.count
    pool_sock = None
    try:
        ssl_sock = ssl_ctx.wrap_socket(sock, server_side=True)
        logger.info(f"[{cid}] TLS OK from {addr}")

        # Set timeouts BEFORE makefile (readline inherits from socket)
        ssl_sock.settimeout(60)
        miner_f = ssl_sock.makefile("rb")

        try:
            pool_sock = socket.create_connection(
                (POOL_HOST, POOL_PORT), timeout=5
            )
            pool_sock.settimeout(120)
            pool_f = pool_sock.makefile("rb")
        except Exception as e:
            logger.error(f"[{cid}] Pool connect failed: {e}")
            ssl_sock.close()
            return

        logger.info(f"[{cid}] Pool connected, relay start")

        def miner_to_pool():
            try:
                while True:
                    data = miner_f.readline()
                    if not data:
                        break
                    msg = data.decode(errors="replace").strip()
                    logger.info(f"[{cid}] M->P: {msg[:150]}")
                    pool_sock.sendall(data)
            except Exception as e:
                logger.info(f"[{cid}] M->P end: {e}")
            try:
                pool_sock.shutdown(socket.SHUT_WR)
            except Exception:
                pass

        def pool_to_miner():
            try:
                while True:
                    data = pool_f.readline()
                    if not data:
                        break
                    msg = data.decode(errors="replace").strip()
                    logger.info(f"[{cid}] P->M: {msg[:150]}")
                    ssl_sock.sendall(data)
            except Exception as e:
                logger.info(f"[{cid}] P->M end: {e}")

        t1 = threading.Thread(target=miner_to_pool, daemon=True)
        t2 = threading.Thread(target=pool_to_miner, daemon=True)
        t1.start()
        t2.start()
        t1.join(timeout=300)
        t2.join(timeout=5)

    except ssl.SSLError as e:
        logger.error(f"[{cid}] TLS err: {e}")
    except Exception as e:
        logger.error(f"[{cid}] err: {e}")
    finally:
        try:
            sock.close()
        except Exception:
            pass
        if pool_sock:
            try:
                pool_sock.close()
            except Exception:
                pass
        logger.info(f"[{cid}] Done")


def main():
    global ssl_ctx
    ca_c, ca_k, srv_c, srv_k = ca.ensure_certs()

    ssl_ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ssl_ctx.load_cert_chain(srv_c, srv_k)
    ssl_ctx.load_verify_locations(ca_c)
    ssl_ctx.verify_mode = ssl.CERT_OPTIONAL

    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind((PROXY_HOST, PROXY_PORT))
    srv.listen(50)

    logger.info("=" * 60)
    logger.info("PearlFortune TLS Proxy v7 (makefile)")
    logger.info(f"Port: {PROXY_HOST}:{PROXY_PORT}")
    logger.info(f"Pool: {POOL_HOST}:{POOL_PORT}")
    logger.info("=" * 60)

    while True:
        try:
            c, a = srv.accept()
            threading.Thread(
                target=handle_client, args=(c, a), daemon=True
            ).start()
        except KeyboardInterrupt:
            break
        except Exception as e:
            logger.error(f"Accept: {e}")
    srv.close()


if __name__ == "__main__":
    main()
