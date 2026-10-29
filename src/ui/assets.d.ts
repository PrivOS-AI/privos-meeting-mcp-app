/** A file inlined into the UI bundle as a `data:` URL (Vite `?url&inline`). */
declare module '*.tar.gz?url&inline' {
  const dataUrl: string;
  export default dataUrl;
}
