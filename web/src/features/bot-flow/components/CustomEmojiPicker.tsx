import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { Search } from 'lucide-react'

import { api } from '@/lib/api'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Separator } from '@/components/ui/separator'
import { cn } from '@/lib/utils'

interface CustomEmojiPickerProps {
  value: string | null
  onChange: (emojiId: string | null) => void
}

/** Pre-loaded catalog of known custom emoji IDs with their categories. */
const BUILTIN_EMOJI_CATALOG: Array<{ id: string; fallback: string; category: string }> = [
  // UI / Navigation
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
  { id: '5206211858444354221', fallback: '🧪', category: 'ui' },
  { id: '5206202791768393003', fallback: '🧭', category: 'ui' },
  { id: '5206222720416643915', fallback: '🔔', category: 'ui' },
  { id: '5278589204207528856', fallback: '📨', category: 'ui' },
  { id: '5276229330131772747', fallback: '👑', category: 'ui' },
  { id: '5278540791336165644', fallback: '📦', category: 'ui' },
  { id: '5278305362703835500', fallback: '🔗', category: 'ui' },
  { id: '5276314275994954605', fallback: '🔨', category: 'ui' },
  { id: '5276422526350681413', fallback: '🎁', category: 'ui' },
  { id: '5278304890257436355', fallback: '🎮', category: 'ui' },
  // Numbers
  { id: '5242380641332393116', fallback: '0️⃣', category: 'numbers' },
  { id: '5244961448525848230', fallback: '1️⃣', category: 'numbers' },
  { id: '5242293676834579345', fallback: '2️⃣', category: 'numbers' },
  { id: '5242652525647127686', fallback: '3️⃣', category: 'numbers' },
  { id: '5242287453426969423', fallback: '4️⃣', category: 'numbers' },
  { id: '5242407832770340528', fallback: '5️⃣', category: 'numbers' },
  { id: '5242669447818277073', fallback: '6️⃣', category: 'numbers' },
  { id: '5242663134216350272', fallback: '7️⃣', category: 'numbers' },
  { id: '5242497782270418294', fallback: '8️⃣', category: 'numbers' },
  { id: '5242286371095211663', fallback: '9️⃣', category: 'numbers' },
  { id: '5242329690135356589', fallback: '➕', category: 'numbers' },
  { id: '5244796895443838315', fallback: '➖', category: 'numbers' },
  { id: '5242612543796567211', fallback: '⭐', category: 'numbers' },
  { id: '5242578970037218790', fallback: '❕', category: 'numbers' },
  { id: '5242205011529719330', fallback: '❔', category: 'numbers' },
  { id: '5242602592357345985', fallback: '🔤', category: 'numbers' },
  // Crypto / Currency
  { id: '5255845368100317401', fallback: '💱', category: 'crypto' },
  { id: '5258157739837779860', fallback: '💱', category: 'crypto' },
  { id: '5256030713119007739', fallback: '💱', category: 'crypto' },
  { id: '5255828733691981585', fallback: '💱', category: 'crypto' },
  { id: '5255787742524103649', fallback: '💱', category: 'crypto' },
  { id: '5255933397750014894', fallback: '💱', category: 'crypto' },
  { id: '5256008271914885402', fallback: '💱', category: 'crypto' },
  { id: '5255806447106679302', fallback: '💱', category: 'crypto' },
  { id: '5193131612853789713', fallback: '🪙', category: 'crypto' },
  { id: '5193193288584158951', fallback: '🪙', category: 'crypto' },
  { id: '5192993061503787796', fallback: '🪙', category: 'crypto' },
  { id: '5194921050848124927', fallback: '🪙', category: 'crypto' },
  { id: '5192731845887810383', fallback: '🪙', category: 'crypto' },
  { id: '5217914179742098180', fallback: '🪙', category: 'crypto' },
  { id: '5269289762493063742', fallback: '🪙', category: 'crypto' },
  { id: '5194983413773266305', fallback: '🪙', category: 'crypto' },
  { id: '5192942020112442148', fallback: '🪙', category: 'crypto' },
  { id: '5193059508942824703', fallback: '🪙', category: 'crypto' },
  { id: '5193004361562745352', fallback: '🪙', category: 'crypto' },
  { id: '5195352119535755156', fallback: '🪙', category: 'crypto' },
  { id: '5192685687874280710', fallback: '🪙', category: 'crypto' },
  { id: '5193144965907110821', fallback: '🪙', category: 'crypto' },
  { id: '5193179982775476271', fallback: '🪙', category: 'crypto' },
  { id: '5195107400889163662', fallback: '🪙', category: 'crypto' },
  // Banks
  { id: '5192803468762441581', fallback: '🏦', category: 'banks' },
  { id: '5192678313415434135', fallback: '🏦', category: 'banks' },
  { id: '5192661099186512001', fallback: '🏦', category: 'banks' },
  { id: '5242644275014951846', fallback: '🏦', category: 'banks' },
  { id: '5242631901214171852', fallback: '🏦', category: 'banks' },
  { id: '5192734006256360392', fallback: '🏦', category: 'banks' },
  { id: '5193134679460437736', fallback: '🏦', category: 'banks' },
  { id: '5193084514242421738', fallback: '🏦', category: 'banks' },
  { id: '5195206313985991273', fallback: '🏦', category: 'banks' },
  { id: '5192689390136089826', fallback: '🏦', category: 'banks' },
  { id: '5194996633682600894', fallback: '🏦', category: 'banks' },
  { id: '5192751963514625238', fallback: '🏦', category: 'banks' },
  { id: '5193115240438455906', fallback: '🏦', category: 'banks' },
  { id: '5195058841988914267', fallback: '🏦', category: 'banks' },
  { id: '5194955350456953187', fallback: '🏦', category: 'banks' },
  { id: '5195018795713847457', fallback: '🏦', category: 'banks' },
]

const CATEGORIES = [
  { key: 'all', label: 'Все' },
  { key: 'ui', label: 'UI' },
  { key: 'numbers', label: '0-9' },
  { key: 'crypto', label: '💱' },
  { key: 'banks', label: '🏦' },
]

export function CustomEmojiPicker({ value, onChange }: CustomEmojiPickerProps) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState('all')
  const [manualId, setManualId] = useState('')

  // Also load operator-imported emojis from DB
  const { data: dbEmojis } = useQuery<Array<{ id: string; key: string; unicode: string; tgEmojiId: string | null }>>({
    queryKey: ['admin', 'bot-config', 'emojis'],
    queryFn: async () => (await api.get('/admin/bot-config/emojis')).data,
    staleTime: 60_000,
  })

  const filteredCatalog = BUILTIN_EMOJI_CATALOG.filter((e) => {
    if (category !== 'all' && e.category !== category) return false
    if (search && !e.fallback.includes(search) && !e.id.includes(search)) return false
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
              <img
                src={`/uploads/emoji/${value}.webp`}
                alt=""
                className="h-4 w-4"
                onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
              />
              <span className="truncate font-mono text-[10px]">{value.slice(0, 12)}…</span>
            </>
          ) : (
            <span className="text-muted-foreground">{t('botFlow.button.emoji')}</span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-0" align="start">
        <Tabs defaultValue="custom" className="w-full">
          <TabsList className="w-full grid grid-cols-2 h-8">
            <TabsTrigger value="custom" className="text-xs">Custom</TabsTrigger>
            <TabsTrigger value="manual" className="text-xs">ID</TabsTrigger>
          </TabsList>

          <TabsContent value="custom" className="p-2 space-y-2">
            {/* Category filter */}
            <div className="flex gap-1 flex-wrap">
              {CATEGORIES.map((cat) => (
                <button
                  key={cat.key}
                  onClick={() => setCategory(cat.key)}
                  className={cn(
                    'px-2 py-0.5 rounded text-[10px] font-medium transition-colors',
                    category === cat.key
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-muted text-muted-foreground hover:bg-muted/80',
                  )}
                >
                  {cat.label}
                </button>
              ))}
            </div>

            {/* Grid */}
            <div className="grid grid-cols-8 gap-1 max-h-48 overflow-y-auto">
              {filteredCatalog.map((emoji) => (
                <button
                  key={emoji.id}
                  onClick={() => handleSelect(emoji.id)}
                  className={cn(
                    'h-8 w-8 rounded flex items-center justify-center text-lg hover:bg-accent transition-colors',
                    value === emoji.id && 'ring-2 ring-primary bg-accent',
                  )}
                  title={emoji.id}
                >
                  <img
                    src={`/uploads/emoji/${emoji.id}.webp`}
                    alt={emoji.fallback}
                    className="h-5 w-5"
                    onError={(e) => {
                      // Fallback to unicode if WebP not available
                      const el = e.target as HTMLImageElement
                      el.style.display = 'none'
                      el.parentElement!.textContent = emoji.fallback
                    }}
                  />
                </button>
              ))}
            </div>

            {/* DB emojis (operator-imported) */}
            {dbEmojis && dbEmojis.filter((e) => e.tgEmojiId).length > 0 && (
              <>
                <Separator />
                <p className="text-[10px] text-muted-foreground font-medium">Imported</p>
                <div className="grid grid-cols-8 gap-1">
                  {dbEmojis
                    .filter((e) => e.tgEmojiId)
                    .map((emoji) => (
                      <button
                        key={emoji.id}
                        onClick={() => handleSelect(emoji.tgEmojiId!)}
                        className={cn(
                          'h-8 w-8 rounded flex items-center justify-center text-lg hover:bg-accent transition-colors',
                          value === emoji.tgEmojiId && 'ring-2 ring-primary bg-accent',
                        )}
                        title={`${emoji.key}: ${emoji.tgEmojiId}`}
                      >
                        {emoji.unicode}
                      </button>
                    ))}
                </div>
              </>
            )}

            {/* Clear button */}
            {value && (
              <Button variant="ghost" size="sm" className="w-full h-7 text-xs" onClick={handleClear}>
                {t('botFlow.button.clearEmoji', 'Clear emoji')}
              </Button>
            )}
          </TabsContent>

          <TabsContent value="manual" className="p-3 space-y-2">
            <p className="text-[11px] text-muted-foreground">
              {t('botFlow.button.manualEmojiHint', 'Paste custom_emoji_id from @RawDataBot')}
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
                className="h-7 text-xs px-2"
                disabled={!manualId.trim()}
                onClick={() => {
                  handleSelect(manualId.trim())
                  setManualId('')
                }}
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
