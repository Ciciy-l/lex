import type { Server } from 'node:http';

// Fetch rejects these ports even on loopback before attempting any I/O. An
// OS-assigned ephemeral port is not necessarily outside this list (Windows).
// https://fetch.spec.whatwg.org/#port-blocking
const blocked = new Set([
  0, 1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79,
  87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137,
  139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532,
  540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723,
  2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669,
  6679, 6697, 10080,
]);

/** Bind on loopback without publishing a port the native Fetch client cannot use. */
export async function listenFetchLoopback(server: Pick<Server, 'listen' | 'once' | 'off' | 'address' | 'close'>): Promise<number> {
  for (let attempt = 0; attempt < 8; attempt++) {
    await new Promise<void>((resolve, reject) => {
      const fail = (error: Error) => { server.off('error', fail); reject(error); };
      server.once('error', fail);
      try { server.listen(0, '127.0.0.1', () => { server.off('error', fail); resolve(); }); }
      catch (error) { server.off('error', fail); reject(error); }
    });
    const address = server.address();
    if (address && typeof address !== 'string' && Number.isInteger(address.port)
      && address.port > 0 && address.port <= 65535 && !blocked.has(address.port)) return address.port;
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
  throw new Error('No Fetch-compatible native loopback port was allocated');
}
