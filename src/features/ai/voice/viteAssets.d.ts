// Vite's asset suffixes, as the voice engine uses them: `?worker&url` bundles a module (the capture
// worklet) and gives its address; `?url` gives a shipped file's address (the ONNX Runtime files the
// Whisper worker loads instead of fetching them from a CDN). Only these two forms are declared.
declare module '*?worker&url' {
  const url: string;
  export default url;
}

declare module '*?url' {
  const url: string;
  export default url;
}
