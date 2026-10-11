/**
 * 虎皮椒（XunhuPay）支付 V3 API 封装
 *
 * 文档参考：https://www.xunhupay.com/doc/api/pay.html
 * 传参方式：POST JSON
 * 签名算法：MD5，参数按 key 字典序排序，跳过空值和 hash 字段，
 * 拼接后直接追加 APPSECRET（无连接符），结果为小写
 */
import crypto from 'crypto'
import https from 'https'

// ============================================================
// 配置
// ============================================================

const APPID = '201906186549'
const APPSECRET = '1eb541350fde8bd62b4f1521334fad76'

const CREATE_ORDER_URL = 'https://api.xunhupay.com/payment/do.html'
const QUERY_ORDER_URL = 'https://api.xunhupay.com/payment/query.html'

// 桌面应用无服务端回调，填落地页地址（API 必填，回调不可达但不影响轮询查询）
const NOTIFY_URL = 'https://yizhuan-app.cn'
const RETURN_URL = 'https://yizhuan-app.cn'

// ============================================================
// 套餐定价（单位：元）
// ============================================================

export const PRICING: Record<PaymentTier, number> = {
  monthly: 5.9,
  quarterly: 9.9,
  pro: 39,
  lifetime: 69,
}

export const TIER_NAMES: Record<PaymentTier, string> = {
  monthly: '月度会员',
  quarterly: '季度会员',
  pro: '年度会员',
  lifetime: '终身会员',
}

// ============================================================
// 类型定义
// ============================================================

export type PaymentTier = 'monthly' | 'quarterly' | 'pro' | 'lifetime'

export interface PaymentOrderResult {
  success: boolean
  message?: string
  tradeOrderId?: string
  codeUrl?: string
  payUrl?: string
  totalFee?: number
  tier?: PaymentTier
}

export interface PaymentQueryResult {
  success: boolean
  message?: string
  tradeOrderId?: string
  status?: 'paid' | 'awaiting' | 'closed'
  totalFee?: number
  paidAt?: string
}

// ============================================================
// 签名算法（按官方文档实现）
// ============================================================

/**
 * 生成虎皮椒 MD5 签名（小写）
 *
 * 1. 将非空参数按 key ASCII 字典序排序
 * 2. 跳过值为空的参数和 hash 字段本身
 * 3. 拼接成 key1=value1&key2=value2 格式
 * 4. 末尾直接拼接 APPSECRET（无 &key= 前缀）
 * 5. MD5 取小写
 */
function generateHash(params: Record<string, string | number>): string {
  const sortedKeys = Object.keys(params).sort()

  const parts: string[] = []
  for (const key of sortedKeys) {
    if (key === 'hash') continue
    const val = params[key]
    if (val === null || val === undefined || val === '') continue
    parts.push(`${key}=${val}`)
  }

  const signStr = parts.join('&')
  const fullStr = signStr + APPSECRET

  const hash = crypto
    .createHash('md5')
    .update(fullStr, 'utf-8')
    .digest('hex')
    .toLowerCase()

  console.log('[支付] 签名原串:', signStr)
  console.log('[支付] 完整串:', fullStr)
  console.log('[支付] hash值:', hash)

  return hash
}

// ============================================================
// 订单号生成
// ============================================================

function generateTradeOrderId(): string {
  const timestamp = Date.now().toString()
  const random = Math.floor(100000 + Math.random() * 900000).toString()
  return `YZ${timestamp}${random}`
}

// ============================================================
// HTTP 请求（form-urlencoded POST）
// ============================================================

function postForm(url: string, data: Record<string, string | number>): Promise<any> {
  return new Promise((resolve, reject) => {
    const body = Object.keys(data)
      .map(key => `${encodeURIComponent(key)}=${encodeURIComponent(String(data[key]))}`)
      .join('&')

    const urlObj = new URL(url)
    const options: https.RequestOptions = {
      hostname: urlObj.hostname,
      port: urlObj.port || 443,
      path: urlObj.pathname + urlObj.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 15000,
    }

    const req = https.request(options, (res) => {
      let responseData = ''
      res.setEncoding('utf-8')
      res.on('data', (chunk) => { responseData += chunk })
      res.on('end', () => {
        try {
          resolve(JSON.parse(responseData))
        } catch {
          resolve({ raw: responseData })
        }
      })
    })

    req.on('error', reject)
    req.on('timeout', () => {
      req.destroy()
      reject(new Error('请求超时'))
    })

    req.write(body)
    req.end()
  })
}

// ============================================================
// 创建订单
// ============================================================

export async function createOrder(tier: PaymentTier): Promise<PaymentOrderResult> {
  try {
    const price = PRICING[tier]
    if (!price) {
      return { success: false, message: `未知的套餐类型：${tier}` }
    }

    const tradeOrderId = generateTradeOrderId()
    const title = `易转 - ${TIER_NAMES[tier]}`

    const params: Record<string, string | number> = {
      version: '1.1',
      appid: APPID,
      trade_order_id: tradeOrderId,
      total_fee: price.toFixed(2),
      title,
      notify_url: NOTIFY_URL,
      return_url: RETURN_URL,
      time: Math.floor(Date.now() / 1000),
      nonce_str: crypto.randomBytes(8).toString('hex'),
    }

    params.hash = generateHash(params)

    console.log('[支付] 请求参数:', JSON.stringify(params, null, 2))

    const response = await postForm(CREATE_ORDER_URL, params)

    console.log('[支付] 响应:', JSON.stringify(response))

    if (response && response.errcode === 0 && response.url_qrcode) {
      return {
        success: true,
        tradeOrderId,
        codeUrl: response.url_qrcode,
        payUrl: response.url,
        totalFee: price,
        tier,
      }
    }

    return {
      success: false,
      message: response?.errmsg || '创建订单失败',
    }
  } catch (err) {
    return {
      success: false,
      message: `创建订单异常：${(err as Error).message}`,
    }
  }
}

// ============================================================
// 查询订单状态
// ============================================================

export async function queryOrder(tradeOrderId: string): Promise<PaymentQueryResult> {
  try {
    const params: Record<string, string | number> = {
      version: '1.1',
      appid: APPID,
      out_trade_order: tradeOrderId,
      time: Math.floor(Date.now() / 1000),
      nonce_str: crypto.randomBytes(8).toString('hex'),
    }

    params.hash = generateHash(params)

    const response = await postForm(QUERY_ORDER_URL, params)

    if (response && response.errcode === 0 && response.data) {
      const rawStatus = response.data.status
      const status: 'paid' | 'awaiting' | 'closed' =
        rawStatus === 'OD' ? 'paid'
        : rawStatus === 'CD' ? 'closed'
        : 'awaiting'

      return {
        success: true,
        tradeOrderId,
        status,
        totalFee: response.data.total_fee ? Number(response.data.total_fee) : undefined,
        paidAt: response.data.paid_at || undefined,
      }
    }

    return {
      success: false,
      message: response?.errmsg || '查询订单失败',
    }
  } catch (err) {
    return {
      success: false,
      message: `查询订单异常：${(err as Error).message}`,
    }
  }
}
