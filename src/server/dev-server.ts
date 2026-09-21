/**
 * Dev-mode UI server: runs an in-process Vite dev server (HMR + source maps) so
 * `npm run dev` stays one process. The browser rendering the Hub talks to Vite
 * directly (over `PUBLIC_URL`, or `http://localhost:<port>` on the same
 * machine), not to an inlined bundle. Production keeps the inline-bundle path
 * (`ui-resource.ts`'s `inlineHtml`); this module only runs when `npm run dev`
 * sets `PRIVOS_DEV_UI=1`.
 */
const DEFAULT_VITE_PORT = 5179;

export interface DevUiServer {
  /** Origin the iframe loads UI assets from. */
  publicUrl: string;
  /** Stop the Vite dev server. */
  close: () => Promise<void>;
}

/** Start the in-process Vite dev server and return the iframe-facing public URL. */
export async function startDevUiServer(): Promise<DevUiServer> {
  const port = Number(process.env.VITE_PORT) || DEFAULT_VITE_PORT;
  const publicUrl = (process.env.PUBLIC_URL || `http://localhost:${port}`).replace(/\/$/, '');
  const isLocalhost = /^http:\/\/localhost(:\d+)?$/.test(publicUrl);
  const tunnelHost = isLocalhost ? undefined : new URL(publicUrl).host;

  const { createServer } = await import('vite');
  const vite = await createServer({
    configFile: false,
    root: 'src/ui',
    plugins: [(await import('@vitejs/plugin-react')).default()],
    server: {
      port,
      strictPort: true,
      cors: true,
      allowedHosts: tunnelHost ? [tunnelHost] : true,
      hmr: tunnelHost
        ? { protocol: 'wss', host: tunnelHost, clientPort: 443 }
        : { protocol: 'ws', host: 'localhost', clientPort: port },
    },
  });
  await vite.listen(port);
  console.log(`[Dev] Vite dev server on http://localhost:${port} — UI served from ${publicUrl}`);

  return {
    publicUrl,
    close: async () => {
      await vite.close();
    },
  };
}
