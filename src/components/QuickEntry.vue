<script setup lang="ts">
import { ref } from 'vue'

const emit = defineEmits<{
  (e: 'quick-action', action: string): void
}>()

const categories = ref([
  {
    title: '文档转换',
    items: [
      { id: 'pdf2docx', label: 'PDF 转 Word', icon: 'pdf', color: '#ef4444', desc: '保留排版' },
      { id: 'pdf2xlsx', label: 'PDF 转 Excel', icon: 'pdf', color: '#10b981', desc: '提取表格' },
      { id: 'pdf2ppt', label: 'PDF 转 PPT', icon: 'pdf', color: '#f59e0b', desc: '演示文稿' },
      { id: 'docx2pdf', label: 'Office 转 PDF', icon: 'docx', color: '#4f46e5', desc: 'Word/PPT/Excel' },
      { id: 'caj2pdf', label: 'CAJ 转 PDF', icon: 'caj', color: '#dc2626', desc: '知网文献' },
    ]
  },
  {
    title: '图片工具',
    items: [
      { id: 'img2png', label: '图片转 PNG', icon: 'img', color: '#10b981', desc: '无损压缩' },
      { id: 'img2jpg', label: '图片转 JPG', icon: 'img', color: '#f59e0b', desc: '体积更小' },
      { id: 'img2webp', label: '图片转 WebP', icon: 'img', color: '#06b6d4', desc: '现代高效格式' },
      { id: 'img2heic', label: '图片转 AVIF', icon: 'heic', color: '#8b5cf6', desc: '高压缩比' },
      { id: 'heic2jpg', label: 'HEIC 转 JPG', icon: 'heic', color: '#8b5cf6', desc: '苹果兼容' },
      { id: 'img-compress', label: '图片压缩', icon: 'compress', color: '#10B981', desc: '减小体积' },
    ]
  },
  {
    title: 'PDF 工具',
    items: [
      { id: 'pdf-merge', label: 'PDF 合并', icon: 'pdf-merge', color: '#7C5CFC', desc: '多文件合一' },
      { id: 'pdf-split', label: 'PDF 拆分', icon: 'pdf-split', color: '#3B82F6', desc: '按需提取' },
      { id: 'pdf-compress', label: 'PDF 压缩', icon: 'compress', color: '#10B981', desc: '减小体积' },
      { id: 'pdf-encrypt', label: 'PDF 加密', icon: 'encrypt', color: '#EF4444', desc: '密码保护' },
      { id: 'pdf-decrypt', label: 'PDF 解密', icon: 'decrypt', color: '#F59E0B', desc: '移除密码' },
      { id: 'pdf-to-image', label: 'PDF 转图片', icon: 'pdf-to-img', color: '#F97316', desc: 'JPG/PNG/WebP' },
    ]
  },
  {
    title: '高级功能',
    items: [
      { id: 'ocr', label: '图片 OCR', icon: 'ocr', color: '#06b6d4', desc: '提取文字' },
      { id: 'videoConvert', label: '视频转换', icon: 'video', color: '#0d9488', desc: '格式互转/提取音频' },
      { id: 'html-to-pdf', label: 'HTML/MD 转 PDF', icon: 'html', color: '#E11D48', desc: '网页/文档转PDF' },
      { id: 'img-to-html', label: '图片转 HTML/MD', icon: 'img-to-html', color: '#8B5CF6', desc: '生成网页文档' },
    ]
  },
])

function handleClick(action: string) {
  emit('quick-action', action)
}
</script>

<template>
  <section class="quick-entry">
    <h2 class="section-title">快捷转换</h2>
    <div v-for="cat in categories" :key="cat.title" class="category-group">
      <h3 class="category-title">{{ cat.title }}</h3>
      <div class="shortcut-grid">
        <button
          v-for="item in cat.items"
          :key="item.id"
          class="shortcut-card"
          @click="handleClick(item.id)"
        >
          <div class="card-icon" :style="{ background: item.color + '12', color: item.color }">
            <svg v-if="item.icon === 'pdf'" viewBox="0 0 24 24" fill="currentColor"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6z" opacity="0.3"/><path d="M14 3v5h5M16 13H8M16 17H8M10 9H8"/></svg>
            <svg v-else-if="item.icon === 'docx'" viewBox="0 0 24 24" fill="currentColor"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6z" opacity="0.3"/><path d="M14 3v5h5M16 13H8M16 17H8M10 9H8"/></svg>
            <svg v-else-if="item.icon === 'img'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>
            <svg v-else-if="item.icon === 'heic'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/></svg>
            <svg v-else-if="item.icon === 'video'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>
            <svg v-else-if="item.icon === 'caj'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6z"/><path d="M14 2v6h6M16 13H8M16 17H8M10 9H8" opacity="0.5"/><text x="12" y="18" text-anchor="middle" font-size="6" fill="currentColor" stroke="none" font-weight="bold">CAJ</text></svg>
            <svg v-else-if="item.icon === 'ocr'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 7V4h3M4 17v3h3M20 7V4h-3M20 17v3h-3M9 9h6v6H9z"/></svg>
            <svg v-else-if="item.icon === 'pdf-merge'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="2" width="14" height="20" rx="2"/><path d="M5 6h14M5 10h14M12 14h7M12 18h7"/></svg>
            <svg v-else-if="item.icon === 'pdf-split'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6"/><path d="M8 13h.01M8 17h.01M12 13h4v4h-4z"/></svg>
            <svg v-else-if="item.icon === 'compress'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 14.899A7 7 0 1115.71 8h1.79a4.5 4.5 0 015 5H19"/><path d="M12 12v9M8 17l4-4 4 4"/></svg>
            <svg v-else-if="item.icon === 'encrypt'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>
            <svg v-else-if="item.icon === 'decrypt'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0110 0v4"/><path d="M12 16l1 1-1 1"/></svg>
            <svg v-else-if="item.icon === 'pdf-to-img'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6"/><rect x="8" y="11" width="8" height="6" rx="1"/><circle cx="10.5" cy="13.5" r="0.5" fill="currentColor"/></svg>
            <svg v-else-if="item.icon === 'watermark'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/><text x="14" y="17" font-size="6" fill="currentColor" stroke="none" font-weight="bold">W</text></svg>
            <svg v-else-if="item.icon === 'html'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
            <svg v-else-if="item.icon === 'img-to-html'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/><polyline points="3 8 6 8 6 11"/></svg>
          </div>
          <div class="card-info">
            <span class="card-label">{{ item.label }}</span>
            <span class="card-desc">{{ item.desc }}</span>
          </div>
        </button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.quick-entry {
  margin-top: 24px;
}

.section-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--ink);
  margin-bottom: 14px;
}

.category-group {
  margin-bottom: 20px;
}

.category-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--muted);
  margin-bottom: 10px;
  padding-left: 2px;
}

.shortcut-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
}

.shortcut-card {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: all 0.2s;
  text-align: left;
}

.shortcut-card:hover {
  border-color: var(--primary-light);
  box-shadow: var(--shadow);
  transform: translateY(-1px);
}

.card-icon {
  width: 40px;
  height: 40px;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.card-icon svg {
  width: 22px;
  height: 22px;
}

.card-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.card-label {
  font-size: 14px;
  font-weight: 600;
  color: var(--ink);
}

.card-desc {
  font-size: 12px;
  color: var(--muted);
}
</style>
