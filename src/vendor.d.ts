declare module 'lcms-wasm' {
  export interface Lcms {
    cmsOpenProfileFromMem(bytes: Uint8Array, length: number): number;
    cmsCloseProfile(profile: number): void;
    cmsCreate_sRGBProfile(): number;
    cmsCreateXYZProfile(): number;
    cmsGetColorSpaceASCII(profile: number): string;
    cmsCreateTransform(input: number, inputFormat: number, output: number, outputFormat: number, intent: number, flags: number): number;
    cmsDoTransform(transform: number, input: Float32Array, size: number): Float32Array;
    cmsDeleteTransform(transform: number): void;
  }
  export function instantiate(options?: { locateFile?: (name: string) => string; wasmBinary?: Uint8Array }): Promise<Lcms>;
  export const TYPE_RGB_DBL: number;
  export const TYPE_XYZ_DBL: number;
}

interface Window {
  reviaDesktop?: {
    setLocale(locale: string): void;
  };
}
