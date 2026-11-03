package pro.antitheft.ide;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.RandomAccessFile;
import java.net.StandardProtocolFamily;
import java.net.UnixDomainSocketAddress;
import java.nio.ByteBuffer;
import java.nio.channels.Channels;
import java.nio.channels.SocketChannel;
import java.nio.charset.StandardCharsets;
import java.util.function.BiConsumer;

/**
 * antitheft's local API over its socket (a Unix socket on Linux and macOS, a named pipe on Windows). HTTP/1.0,
 * one request per connection, so answers are never chunked. Nothing here holds a credential.
 */
final class Daemon {
    private Daemon() {}

    static final boolean WINDOWS = System.getProperty("os.name", "").toLowerCase().contains("win");
    static final String DEFAULT_SOCKET = WINDOWS ? "\\\\.\\pipe\\kinnector-antitheft-api" : "/var/run/kinnector/antitheft.sock";

    /** A development build may point at a test daemon (`-Dantitheft.dev.socket=`); a release build never does. */
    static String socket() {
        if (Dev.ENABLED) {
            String s = System.getProperty("antitheft.dev.socket", System.getenv("ANTITHEFT_SOCKET"));
            if (s != null && !s.isEmpty()) return s;
        }
        return DEFAULT_SOCKET;
    }

    record Response(int status, String contentType, byte[] body) {
        String text() {
            return new String(body, StandardCharsets.UTF_8);
        }
    }

    interface Conn extends AutoCloseable {
        InputStream in();

        void write(byte[] b) throws IOException;

        @Override
        void close() throws IOException;
    }

    static Conn open() throws IOException {
        if (WINDOWS) {
            RandomAccessFile pipe = new RandomAccessFile(socket(), "rw");
            return new Conn() {
                public InputStream in() {
                    return Channels.newInputStream(pipe.getChannel());
                }

                public void write(byte[] b) throws IOException {
                    pipe.write(b);
                }

                public void close() throws IOException {
                    pipe.close();
                }
            };
        }
        SocketChannel ch = SocketChannel.open(StandardProtocolFamily.UNIX);
        ch.connect(UnixDomainSocketAddress.of(socket()));
        return new Conn() {
            public InputStream in() {
                return Channels.newInputStream(ch);
            }

            public void write(byte[] b) throws IOException {
                ByteBuffer buf = ByteBuffer.wrap(b);
                while (buf.hasRemaining()) ch.write(buf);
            }

            public void close() throws IOException {
                ch.close();
            }
        };
    }

    private static byte[] requestBytes(String method, String path, String json) {
        byte[] body = json == null ? new byte[0] : json.getBytes(StandardCharsets.UTF_8);
        String head = method + " " + path + " HTTP/1.0\r\nHost: localhost\r\n"
            + (json == null ? "" : "Content-Type: application/json\r\nContent-Length: " + body.length + "\r\n") + "\r\n";
        byte[] h = head.getBytes(StandardCharsets.UTF_8);
        byte[] all = new byte[h.length + body.length];
        System.arraycopy(h, 0, all, 0, h.length);
        System.arraycopy(body, 0, all, h.length, body.length);
        return all;
    }

    /** One request; null when antitheft does not answer. */
    static Response request(String method, String path, String json) {
        try (Conn c = open()) {
            c.write(requestBytes(method, path, json));
            byte[] raw = c.in().readNBytes(4 * 1024 * 1024);
            int split = indexOf(raw, "\r\n\r\n".getBytes(StandardCharsets.US_ASCII));
            if (split < 0) return null;
            String head = new String(raw, 0, split, StandardCharsets.ISO_8859_1);
            String[] lines = head.split("\r\n");
            int status = Integer.parseInt(lines[0].split(" ")[1]);
            String type = "";
            for (String l : lines) if (l.toLowerCase().startsWith("content-type:")) type = l.substring(13).trim();
            byte[] body = java.util.Arrays.copyOfRange(raw, split + 4, raw.length);
            return new Response(status, type, body);
        } catch (Exception e) {
            return null;
        }
    }

    /** Server-sent events on a connection of its own, on the calling thread, until it ends. */
    static void stream(String path, BiConsumer<String, String> onEvent) {
        try (Conn c = open()) {
            c.write(requestBytes("GET", path, null));
            InputStream in = c.in();
            StringBuilder line = new StringBuilder();
            boolean head = true;
            String name = "message";
            StringBuilder data = new StringBuilder();
            int b;
            ByteArrayOutputStream cur = new ByteArrayOutputStream();
            while ((b = in.read()) != -1) {
                if (b != '\n') {
                    cur.write(b);
                    continue;
                }
                String l = cur.toString(StandardCharsets.UTF_8).replaceAll("\r$", "");
                cur.reset();
                if (head) {
                    if (l.isEmpty()) head = false;
                    continue;
                }
                if (l.isEmpty()) {
                    if (data.length() > 0) onEvent.accept(name, data.toString());
                    name = "message";
                    data.setLength(0);
                } else if (l.startsWith("event:")) name = l.substring(6).trim();
                else if (l.startsWith("data:")) data.append(l.substring(5).trim());
            }
        } catch (Exception ignored) {
            // the caller reconnects
        }
    }

    private static int indexOf(byte[] a, byte[] p) {
        outer:
        for (int i = 0; i + p.length <= a.length; i++) {
            for (int j = 0; j < p.length; j++) if (a[i + j] != p[j]) continue outer;
            return i;
        }
        return -1;
    }
}
