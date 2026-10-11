/**
 * Electron 主进程 Polyfills
 * - DOMMatrix: pdfjs-dist 在 Node.js 主进程中需要此浏览器 API
 */

interface DOMMatrixInit {
  a?: number; b?: number; c?: number; d?: number; e?: number; f?: number
  m11?: number; m12?: number; m13?: number; m14?: number
  m21?: number; m22?: number; m23?: number; m24?: number
  m31?: number; m32?: number; m33?: number; m34?: number
  m41?: number; m42?: number; m43?: number; m44?: number
}

class DOMMatrixPolyfill {
  a = 1; b = 0; c = 0; d = 1; e = 0; f = 0
  m11 = 1; m12 = 0; m13 = 0; m14 = 0
  m21 = 0; m22 = 1; m23 = 0; m24 = 0
  m31 = 0; m32 = 0; m33 = 1; m34 = 0
  m41 = 0; m42 = 0; m43 = 0; m44 = 1

  constructor(init?: number[] | DOMMatrixInit | string) {
    if (typeof init === 'string') {
      const match = init.match(/matrix\(([^)]+)\)/)
      if (match) {
        const values = match[1].split(/[,\s]+/).map(Number)
        if (values.length === 6) {
          this.a = this.m11 = values[0]
          this.b = this.m12 = values[1]
          this.c = this.m21 = values[2]
          this.d = this.m22 = values[3]
          this.e = this.m41 = values[4]
          this.f = this.m42 = values[5]
        }
      }
    } else if (Array.isArray(init)) {
      const [a = 1, b = 0, c = 0, d = 1, e = 0, f = 0] = init
      this.a = this.m11 = a
      this.b = this.m12 = b
      this.c = this.m21 = c
      this.d = this.m22 = d
      this.e = this.m41 = e
      this.f = this.m42 = f
    } else if (init && typeof init === 'object') {
      this.a = this.m11 = init.a ?? init.m11 ?? 1
      this.b = this.m12 = init.b ?? init.m12 ?? 0
      this.c = this.m21 = init.c ?? init.m21 ?? 0
      this.d = this.m22 = init.d ?? init.m22 ?? 1
      this.e = this.m41 = init.e ?? init.m41 ?? 0
      this.f = this.m42 = init.f ?? init.m42 ?? 0
    }
  }

  multiplySelf(other: DOMMatrixPolyfill): this {
    const { a: a1, b: b1, c: c1, d: d1, e: e1, f: f1 } = this
    const { a: a2, b: b2, c: c2, d: d2, e: e2, f: f2 } = other
    this.a = a1 * a2 + c1 * b2
    this.b = b1 * a2 + d1 * b2
    this.c = a1 * c2 + c1 * d2
    this.d = b1 * c2 + d1 * d2
    this.e = a1 * e2 + c1 * f2 + e1
    this.f = b1 * e2 + d1 * f2 + f1
    this._sync2D()
    return this
  }

  preMultiplySelf(other: DOMMatrixPolyfill): this {
    const { a: a1, b: b1, c: c1, d: d1, e: e1, f: f1 } = other
    const { a: a2, b: b2, c: c2, d: d2, e: e2, f: f2 } = this
    this.a = a1 * a2 + c1 * b2
    this.b = b1 * a2 + d1 * b2
    this.c = a1 * c2 + c1 * d2
    this.d = b1 * c2 + d1 * d2
    this.e = a1 * e2 + c1 * f2 + e1
    this.f = b1 * e2 + d1 * f2 + f1
    this._sync2D()
    return this
  }

  translate(x: number, y: number): this {
    return this.multiplySelf(new DOMMatrixPolyfill([1, 0, 0, 1, x, y]))
  }

  scale(x: number, y?: number): this {
    return this.multiplySelf(new DOMMatrixPolyfill([x, 0, 0, y ?? x, 0, 0]))
  }

  rotate(angle: number): this {
    const rad = (angle * Math.PI) / 180
    const cos = Math.cos(rad), sin = Math.sin(rad)
    return this.multiplySelf(new DOMMatrixPolyfill([cos, sin, -sin, cos, 0, 0]))
  }

  invertSelf(): this {
    const { a, b, c, d, e, f } = this
    const det = a * d - b * c
    if (Math.abs(det) < 1e-10) { this._identity(); return this }
    const inv = 1 / det
    this.a = d * inv
    this.b = -b * inv
    this.c = -c * inv
    this.d = a * inv
    this.e = (c * f - d * e) * inv
    this.f = (b * e - a * f) * inv
    this._sync2D()
    return this
  }

  get is2D(): boolean { return true }
  get isIdentity(): boolean {
    return this.a === 1 && this.b === 0 && this.c === 0 && this.d === 1 && this.e === 0 && this.f === 0
  }

  private _sync2D() {
    this.m11 = this.a; this.m12 = this.b
    this.m21 = this.c; this.m22 = this.d
    this.m41 = this.e; this.m42 = this.f
  }

  private _identity() {
    this.a = this.m11 = 1; this.b = this.m12 = 0
    this.c = this.m21 = 0; this.d = this.m22 = 1
    this.e = this.m41 = 0; this.f = this.m42 = 0
  }
}

if (typeof globalThis.DOMMatrix === 'undefined') {
  ;(globalThis as any).DOMMatrix = DOMMatrixPolyfill
}
