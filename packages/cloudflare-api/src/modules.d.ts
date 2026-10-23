declare module '*.wasm' {
  const value: WebAssembly.Module;
  export default value;
}
declare module 'bwip-js' {
  const bwipjs: { toSVG(options: Record<string, unknown>): string };
  export default bwipjs;
}
