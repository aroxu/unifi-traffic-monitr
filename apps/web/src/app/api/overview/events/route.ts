import {createNotificationClient} from '@utm/db';
import {authorized} from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Reserve a bounded number of dedicated LISTEN connections per web process.
let activeStreams = 0;
const maxStreams = 8;

export async function GET(request: Request) {
  const rejected = await authorized();
  if (rejected) return rejected;
  if (activeStreams >= maxStreams) return Response.json({error: 'stream_capacity'}, {status: 503,
    headers: {'Cache-Control': 'private, no-store'}});

  const client = createNotificationClient();
  activeStreams++;
  try {
    await client.connect();
    await client.query('LISTEN utm_collection');
  } catch {
    activeStreams--;
    await client.end().catch(() => {});
    return Response.json({error: 'stream_unavailable'}, {status: 503,
      headers: {'Cache-Control': 'private, no-store'}});
  }

  const encoder = new TextEncoder();
  let close = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const send = (message: string) => {
        if (closed) return;
        try { controller.enqueue(encoder.encode(message)); }
        catch { close(); }
      };
      const onNotification = () => send('event: refresh\ndata: changed\n\n');
      const onError = () => close();
      const onAbort = () => close();
      const heartbeat = setInterval(() => send(': keepalive\n\n'), 20000);
      // A new connection rechecks the admin session after this lifetime.
      const lifetime = setTimeout(() => close(), 15 * 60 * 1000);
      close = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        clearTimeout(lifetime);
        request.signal.removeEventListener('abort', onAbort);
        client.off('notification', onNotification);
        client.off('end', onError);
        activeStreams--;
        void client.end().catch(() => {}).finally(() => client.off('error', onError));
        try { controller.close(); } catch { /* The browser already canceled the stream. */ }
      };
      client.on('notification', onNotification);
      client.on('error', onError);
      client.on('end', onError);
      request.signal.addEventListener('abort', onAbort, {once: true});
      if (request.signal.aborted) { close(); return; }
      send('retry: 3000\nevent: ready\ndata: connected\n\n');
    },
    cancel() { close(); }
  });
  return new Response(stream, {headers: {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'private, no-cache, no-store, no-transform',
    'X-Accel-Buffering': 'no',
    'Connection': 'keep-alive'
  }});
}
