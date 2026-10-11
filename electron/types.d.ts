/**
 * 第三方模块类型声明（无官方 @types 的模块）
 */

declare module 'heic-convert' {
  interface HeicConvertOptions {
    buffer: Buffer | Uint8Array
    format: 'JPEG' | 'PNG'
    quality: number
  }
  interface HeicConvertResult {
    data: Uint8Array
    format: string
  }
  function heicConvert(options: HeicConvertOptions): Promise<HeicConvertResult>
  export default heicConvert
}
