import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Smile } from 'lucide-react'

import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'

import { EmojiPreview } from '../../custom-emoji/emoji-preview'
import { useEmojiRegistry } from '../../custom-emoji/use-emoji-registry'

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

export function CustomEmojiPicker({ value, onChange }: CustomEmojiPickerProps) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [manualId, setManualId] = useState('')
  const [unicodeTab, setUnicodeTab] = useState(0)
  // Central registry — single source of truth for premium custom emoji.
  const { packs, byCustomEmojiId } = useEmojiRegistry({ enabled: open })

  const handleSelect = (emojiId: string) => {
    onChange(emojiId)
    setOpen(false)
  }

  const handleClear = () => {
    onChange(null)
    setOpen(false)
  }

  const selected = value ? byCustomEmojiId.get(value) : undefined

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="h-7 text-[11px] w-full justify-start gap-1.5">
          {value ? (
            <>
              {selected ? (
                <EmojiPreview
                  imageUrl={selected.imageUrl}
                  lottieUrl={selected.lottieUrl}
                  videoUrl={selected.videoUrl}
                  alt={selected.name}
                  className="h-4 w-4 shrink-0"
                />
              ) : (
                <span className="text-sm">🔹</span>
              )}
              <span className="truncate font-mono text-[10px] text-muted-foreground">
                {selected ? selected.name : `${value.slice(0, 10)}…`}
              </span>
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
        <Tabs defaultValue="premium" className="w-full">
          <TabsList className="w-full grid grid-cols-3 h-8 rounded-none border-b">
            <TabsTrigger value="premium" className="text-[11px]">{t('botFlow.button.emojiTabPacks')}</TabsTrigger>
            <TabsTrigger value="unicode" className="text-[11px]">Unicode</TabsTrigger>
            <TabsTrigger value="id" className="text-[11px]">ID</TabsTrigger>
          </TabsList>

          {/* Premium custom emoji — sourced from the central registry */}
          <TabsContent value="premium" className="p-2 space-y-2 m-0">
            {packs.length === 0 ? (
              <p className="py-6 text-center text-[11px] text-muted-foreground">
                {t('botFlow.button.emojiPacksEmpty')}
              </p>
            ) : (
              <div className="max-h-44 space-y-2 overflow-y-auto">
                {packs.map((pack) => (
                  <div key={pack.id} className="space-y-1">
                    <p className="text-[10px] font-medium text-muted-foreground">{pack.name}</p>
                    <div className="grid grid-cols-8 gap-0.5">
                      {pack.emojis
                        .filter((emoji) => emoji.customEmojiId)
                        .map((emoji) => (
                          <button
                            key={emoji.slug}
                            type="button"
                            onClick={() => handleSelect(emoji.customEmojiId!)}
                            className={cn(
                              'h-7 w-7 rounded flex items-center justify-center hover:bg-accent transition-colors',
                              value === emoji.customEmojiId && 'ring-2 ring-primary bg-accent',
                            )}
                            title={emoji.name}
                          >
                            <EmojiPreview
                              imageUrl={emoji.imageUrl}
                              lottieUrl={emoji.lottieUrl}
                              videoUrl={emoji.videoUrl}
                              alt={emoji.name}
                              playMode="hover"
                              forcePlay={value === emoji.customEmojiId}
                              className="h-6 w-6"
                            />
                          </button>
                        ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
            <p className="text-[9px] text-muted-foreground leading-tight">
              {t('botFlow.button.emojiPacksHint')}
            </p>
            {value && (
              <Button variant="ghost" size="sm" className="w-full h-6 text-[10px]" onClick={handleClear}>
                {t('botFlow.button.clearEmoji')}
              </Button>
            )}
          </TabsContent>

          {/* Standard Unicode emoji — built-in, copied to clipboard for labels */}
          <TabsContent value="unicode" className="p-0 m-0">
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
            <div className="h-44 overflow-y-auto p-1.5">
              <div className="grid grid-cols-8 gap-0.5">
                {UNICODE_CATEGORIES[unicodeTab].emojis.map((emoji) => (
                  <button
                    key={emoji}
                    onClick={() => {
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
