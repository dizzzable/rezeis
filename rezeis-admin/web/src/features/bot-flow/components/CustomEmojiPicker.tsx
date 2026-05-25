import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Smile } from 'lucide-react'

import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'

interface CustomEmojiPickerProps {
  value: string | null
  onChange: (emojiId: string | null) => void
}

// ── Standard Unicode emoji (most used for bot buttons) ──────────────────────
const UNICODE_CATEGORIES: Array<{ label: string; emojis: string[] }> = [
  { label: '😀', emojis: ['😀','😃','😄','😁','😆','😅','🤣','😂','🙂','😉','😊','😇','🥰','😍','🤩','😘','😗','😋','😛','🤑','🤗','🤭','🤫','🤔','😐','😑','😶','😏','😒','🙄','😬','😮‍💨','🤥','😌','😔','😪','🤤','😴','😷','🤒','🤕','🤢','🤮','🥵','🥶','🥴','😵','🤯','🤠','🥳','🥸','😎','🤓','🧐'] },
  { label: '👋', emojis: ['👋','🤚','🖐','✋','🖖','👌','🤌','🤏','✌️','🤞','🤟','🤘','🤙','👈','👉','👆','🖕','👇','☝️','👍','👎','✊','👊','🤛','🤜','👏','🙌','👐','🤲','🤝','🙏','💪','🦾','🦿','🦵','🦶','👂','🦻','👃','🧠','🫀','🫁','🦷','🦴','👀','👁','👅','👄'] },
  { label: '⭐', emojis: ['⭐','🌟','✨','⚡','🔥','💥','❤️','🧡','💛','💚','💙','💜','🖤','🤍','🤎','💔','❣️','💕','💞','💓','💗','💖','💘','💝','💟','☮️','✝️','☪️','🕉','☸️','✡️','🔯','🕎','☯️','☦️','🛐','⛎','♈','♉','♊','♋','♌','♍','♎','♏','♐','♑','♒','♓','🆔','⚛️'] },
  { label: '🏠', emojis: ['🏠','🏡','🏢','🏣','🏤','🏥','🏦','🏨','🏩','🏪','🏫','🏬','🏭','🏯','🏰','💒','🗼','🗽','⛪','🕌','🛕','🕍','⛩','🕋','⛲','⛺','🌁','🌃','🏙','🌄','🌅','🌆','🌇','🌉','♨️','🎠','🎡','🎢','💈','🎪','🚂','🚃','🚄','🚅','🚆','🚇','🚈','🚉','🚊','🚝'] },
  { label: '📱', emojis: ['📱','📲','💻','⌨️','🖥','🖨','🖱','🖲','🕹','🗜','💽','💾','💿','📀','📼','📷','📸','📹','🎥','📽','🎞','📞','☎️','📟','📠','📺','📻','🎙','🎚','🎛','🧭','⏱','⏲','⏰','🕰','⌛','⏳','📡','🔋','🔌','💡','🔦','🕯','🧯','🛢','💸','💵','💴','💶','💷','🪙'] },
  { label: '✅', emojis: ['✅','❌','❓','❗','‼️','⁉️','💯','🔴','🟠','🟡','🟢','🔵','🟣','⚫','⚪','🟤','🔶','🔷','🔸','🔹','🔺','🔻','💠','🔘','🔳','🔲','▪️','▫️','◾','◽','◼️','◻️','⬛','⬜','🟥','🟧','🟨','🟩','🟦','🟪','⬆️','↗️','➡️','↘️','⬇️','↙️','⬅️','↖️','↕️','↔️'] },
  { label: '🛒', emojis: ['🛒','🛍','💰','💳','🧾','💎','⚖️','🔑','🗝','🔒','🔓','🔏','🔐','🏷','📌','📍','📎','🖇','📐','📏','🗂','📁','📂','🗃','🗄','🗑','📤','📥','📦','📫','📪','📬','📭','📮','🗳','✏️','✒️','🖋','🖊','🖌','🖍','📝','📊','📈','📉','📃','📄','📑','🗒','📅'] },
]

// ── Custom Premium emoji catalog ────────────────────────────────────────────
const CUSTOM_EMOJI_CATALOG: Array<{ id: string; fallback: string; category: string }> = [
  // UI
  { id: '5278611606756942667', fallback: '❤️', category: 'ui' },
  { id: '5278227821364275264', fallback: '📁', category: 'ui' },
  { id: '5276111746812112286', fallback: '⭐', category: 'ui' },
  { id: '5278602437001767574', fallback: '🔓', category: 'ui' },
  { id: '5276262671962892944', fallback: '🛡', category: 'ui' },
  { id: '5276240711795107620', fallback: '⚠️', category: 'ui' },
  { id: '5278578973595427038', fallback: '🚫', category: 'ui' },
  { id: '5278647306525108244', fallback: '🖥', category: 'ui' },
  { id: '5278753302023004775', fallback: 'ℹ️', category: 'ui' },
  { id: '5278528159837348960', fallback: '📢', category: 'ui' },
  { id: '5278411813468269386', fallback: '✅', category: 'ui' },
  { id: '5278613311858959074', fallback: '🛒', category: 'ui' },
  { id: '5276384644739129761', fallback: '🗑', category: 'ui' },
  { id: '5276412364458059956', fallback: '🕓', category: 'ui' },
  { id: '5278778882848220741', fallback: '📊', category: 'ui' },
  { id: '5278413853577734640', fallback: '🏠', category: 'ui' },
  { id: '5276127848644503161', fallback: '🤖', category: 'ui' },
  { id: '5276220667182736079', fallback: '📥', category: 'ui' },
  { id: '5206476089127372379', fallback: '⭐', category: 'ui' },
  { id: '5206626000665868017', fallback: '📚', category: 'ui' },
  { id: '5206401524200145033', fallback: '🔼', category: 'ui' },
  { id: '5206510891247371052', fallback: '🔽', category: 'ui' },
  { id: '5206702193385700709', fallback: '📦', category: 'ui' },
  { id: '5206222720416643915', fallback: '🔔', category: 'ui' },
  { id: '5278589204207528856', fallback: '📨', category: 'ui' },
  { id: '5276229330131772747', fallback: '👑', category: 'ui' },
  { id: '5278305362703835500', fallback: '🔗', category: 'ui' },
  { id: '5276314275994954605', fallback: '🔨', category: 'ui' },
  { id: '5276422526350681413', fallback: '🎁', category: 'ui' },
  { id: '5278304890257436355', fallback: '🎮', category: 'ui' },
  // Numbers
  { id: '5242380641332393116', fallback: '0️⃣', category: 'num' },
  { id: '5244961448525848230', fallback: '1️⃣', category: 'num' },
  { id: '5242293676834579345', fallback: '2️⃣', category: 'num' },
  { id: '5242652525647127686', fallback: '3️⃣', category: 'num' },
  { id: '5242287453426969423', fallback: '4️⃣', category: 'num' },
  { id: '5242407832770340528', fallback: '5️⃣', category: 'num' },
  { id: '5242669447818277073', fallback: '6️⃣', category: 'num' },
  { id: '5242663134216350272', fallback: '7️⃣', category: 'num' },
  { id: '5242497782270418294', fallback: '8️⃣', category: 'num' },
  { id: '5242286371095211663', fallback: '9️⃣', category: 'num' },
  { id: '5242329690135356589', fallback: '➕', category: 'num' },
  { id: '5244796895443838315', fallback: '➖', category: 'num' },
  // Payments
  { id: '5255845368100317401', fallback: '💱', category: 'pay' },
  { id: '5193131612853789713', fallback: '🪙', category: 'pay' },
  { id: '5193193288584158951', fallback: '🪙', category: 'pay' },
  { id: '5192993061503787796', fallback: '🪙', category: 'pay' },
  { id: '5192803468762441581', fallback: '🏦', category: 'pay' },
  { id: '5192678313415434135', fallback: '🏦', category: 'pay' },
  { id: '5192661099186512001', fallback: '🏦', category: 'pay' },
  { id: '5192734006256360392', fallback: '🏦', category: 'pay' },
  { id: '5192689390136089826', fallback: '🏦', category: 'pay' },
  { id: '5194996633682600894', fallback: '🏦', category: 'pay' },
]

const useCustomCategories = (
  t: (key: string) => string,
): readonly { key: string; label: string }[] => [
  { key: 'all', label: t('botFlow.emojiCategories.all') },
  { key: 'ui', label: 'UI' },
  { key: 'num', label: '0-9' },
  { key: 'pay', label: '💰' },
]

export function CustomEmojiPicker({ value, onChange }: CustomEmojiPickerProps) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [category, setCategory] = useState('all')
  const [manualId, setManualId] = useState('')
  const [unicodeTab, setUnicodeTab] = useState(0)
  const CUSTOM_CATEGORIES = useCustomCategories(t)

  const filteredCatalog = CUSTOM_EMOJI_CATALOG.filter((e) => {
    if (category !== 'all' && e.category !== category) return false
    return true
  })

  const handleSelect = (emojiId: string) => {
    onChange(emojiId)
    setOpen(false)
  }

  const handleClear = () => {
    onChange(null)
    setOpen(false)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="h-7 text-[11px] w-full justify-start gap-1.5">
          {value ? (
            <>
              {(() => {
                const found = CUSTOM_EMOJI_CATALOG.find((em) => em.id === value)
                return <span className="text-sm">{found?.fallback ?? '🔹'}</span>
              })()}
              <span className="truncate font-mono text-[10px] text-muted-foreground">{value.slice(0, 10)}…</span>
            </>
          ) : (
            <span className="text-muted-foreground flex items-center gap-1">
              <Smile className="h-3 w-3" />
              {t('botFlow.button.emoji')}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-0" align="start" side="left">
        <Tabs defaultValue="unicode" className="w-full">
          <TabsList className="w-full grid grid-cols-3 h-8 rounded-none border-b">
            <TabsTrigger value="unicode" className="text-[11px]">Unicode</TabsTrigger>
            <TabsTrigger value="premium" className="text-[11px]">Premium</TabsTrigger>
            <TabsTrigger value="id" className="text-[11px]">ID</TabsTrigger>
          </TabsList>

          {/* Standard Unicode emoji — built-in, no CDN */}
          <TabsContent value="unicode" className="p-0 m-0">
            {/* Category tabs */}
            <div className="flex gap-0.5 px-1.5 py-1 border-b overflow-x-auto">
              {UNICODE_CATEGORIES.map((cat, idx) => (
                <button
                  key={idx}
                  onClick={() => setUnicodeTab(idx)}
                  className={cn(
                    'h-7 w-7 rounded flex items-center justify-center text-base shrink-0 transition-colors',
                    unicodeTab === idx ? 'bg-accent' : 'hover:bg-muted',
                  )}
                >
                  {cat.label}
                </button>
              ))}
            </div>
            {/* Emoji grid */}
            <div className="h-44 overflow-y-auto p-1.5">
              <div className="grid grid-cols-8 gap-0.5">
                {UNICODE_CATEGORIES[unicodeTab].emojis.map((emoji) => (
                  <button
                    key={emoji}
                    onClick={() => {
                      // Unicode emoji — not for icon_custom_emoji_id, just close
                      // User should paste into button label instead
                      navigator.clipboard.writeText(emoji)
                      setOpen(false)
                    }}
                    className="h-7 w-7 rounded flex items-center justify-center text-base hover:bg-accent transition-colors"
                    title={emoji}
                  >
                    {emoji}
                  </button>
                ))}
              </div>
            </div>
            <div className="px-2 py-1.5 border-t">
              <p className="text-[9px] text-muted-foreground leading-tight">
                {t('botFlow.button.unicodeHint')}
              </p>
            </div>
          </TabsContent>

          {/* Custom Premium emoji */}
          <TabsContent value="premium" className="p-2 space-y-1.5 m-0">
            <div className="flex gap-1 flex-wrap">
              {CUSTOM_CATEGORIES.map((cat) => (
                <button
                  key={cat.key}
                  onClick={() => setCategory(cat.key)}
                  className={cn(
                    'px-1.5 py-0.5 rounded text-[10px] font-medium transition-colors',
                    category === cat.key
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-muted text-muted-foreground hover:bg-muted/80',
                  )}
                >
                  {cat.label}
                </button>
              ))}
            </div>
            <div className="grid grid-cols-8 gap-0.5 max-h-40 overflow-y-auto">
              {filteredCatalog.map((emoji) => (
                <button
                  key={emoji.id}
                  onClick={() => handleSelect(emoji.id)}
                  className={cn(
                    'h-7 w-7 rounded flex items-center justify-center text-base hover:bg-accent transition-colors',
                    value === emoji.id && 'ring-2 ring-primary bg-accent',
                  )}
                  title={emoji.id}
                >
                  {emoji.fallback}
                </button>
              ))}
            </div>
            {value && (
              <Button variant="ghost" size="sm" className="w-full h-6 text-[10px]" onClick={handleClear}>
                {t('botFlow.button.clearEmoji')}
              </Button>
            )}
          </TabsContent>

          {/* Manual ID */}
          <TabsContent value="id" className="p-2.5 space-y-2 m-0">
            <p className="text-[10px] text-muted-foreground">
              {t('botFlow.button.manualEmojiHint')}
            </p>
            <div className="flex gap-1.5">
              <Input
                value={manualId}
                onChange={(e) => setManualId(e.target.value)}
                placeholder="5278611606756942667"
                className="h-7 text-[11px] font-mono"
              />
              <Button
                size="sm"
                className="h-7 text-[10px] px-2.5"
                disabled={!manualId.trim()}
                onClick={() => { handleSelect(manualId.trim()); setManualId('') }}
              >
                OK
              </Button>
            </div>
          </TabsContent>
        </Tabs>
      </PopoverContent>
    </Popover>
  )
}
