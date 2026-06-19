import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Smile } from 'lucide-react'

import { api } from '@/lib/api'
import { EmojiPreview } from '@/features/custom-emoji/emoji-preview'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

/**
 * Lightweight, dependency-free emoji picker. A curated set of common emojis
 * grouped by category, with a keyword search. Inserts the selected emoji via
 * the `onSelect` callback (the caller splices it into the text at the caret).
 */
interface EmojiEntry {
  readonly c: string
  readonly k: string
}

const EMOJI_GROUPS: ReadonlyArray<{ readonly id: string; readonly items: readonly EmojiEntry[] }> = [
  {
    id: 'smileys',
    items: [
      { c: '😀', k: 'smile grin happy' },
      { c: '😃', k: 'smile happy' },
      { c: '😄', k: 'smile happy laugh' },
      { c: '😁', k: 'grin' },
      { c: '😆', k: 'laugh' },
      { c: '😅', k: 'sweat laugh' },
      { c: '😂', k: 'joy laugh tears' },
      { c: '🤣', k: 'rofl laugh' },
      { c: '😊', k: 'blush happy' },
      { c: '🙂', k: 'slight smile' },
      { c: '😉', k: 'wink' },
      { c: '😍', k: 'heart eyes love' },
      { c: '🥰', k: 'love hearts' },
      { c: '😘', k: 'kiss' },
      { c: '😎', k: 'cool sunglasses' },
      { c: '🤩', k: 'star struck' },
      { c: '🤔', k: 'thinking' },
      { c: '🤗', k: 'hug' },
      { c: '😇', k: 'angel' },
      { c: '🙃', k: 'upside down' },
      { c: '😴', k: 'sleep' },
      { c: '😢', k: 'cry sad' },
      { c: '😭', k: 'cry sob' },
      { c: '😡', k: 'angry mad' },
      { c: '🤯', k: 'mind blown' },
      { c: '😱', k: 'scream shock' },
      { c: '🥳', k: 'party celebrate' },
      { c: '😏', k: 'smirk' },
      { c: '😬', k: 'grimace' },
      { c: '🤝', k: 'handshake deal' },
      { c: '😐', k: 'neutral' },
      { c: '😑', k: 'expressionless' },
      { c: '😶', k: 'no mouth' },
      { c: '🙄', k: 'roll eyes' },
      { c: '😮', k: 'open mouth wow' },
      { c: '😯', k: 'hushed' },
      { c: '😲', k: 'astonished' },
      { c: '🥺', k: 'pleading puppy' },
      { c: '😤', k: 'triumph steam' },
      { c: '😳', k: 'flushed' },
      { c: '🤨', k: 'raised eyebrow' },
      { c: '😜', k: 'wink tongue' },
      { c: '🤪', k: 'zany' },
      { c: '😝', k: 'tongue squint' },
      { c: '🤤', k: 'drool' },
      { c: '😷', k: 'mask sick' },
      { c: '🤒', k: 'thermometer sick' },
      { c: '🥶', k: 'cold freezing' },
      { c: '🥵', k: 'hot' },
      { c: '🤓', k: 'nerd' },
      { c: '🧐', k: 'monocle' },
      { c: '😈', k: 'devil smiling' },
      { c: '👿', k: 'imp angry' },
      { c: '👻', k: 'ghost' },
      { c: '💀', k: 'skull dead' },
      { c: '🤡', k: 'clown' },
      { c: '👽', k: 'alien' },
      { c: '🤖', k: 'robot' },
      { c: '😺', k: 'cat smile' },
      { c: '🙈', k: 'see no evil monkey' },
      { c: '🙉', k: 'hear no evil monkey' },
      { c: '🙊', k: 'speak no evil monkey' },
    ],
  },
  {
    id: 'gestures',
    items: [
      { c: '👍', k: 'thumbs up like' },
      { c: '👎', k: 'thumbs down dislike' },
      { c: '👌', k: 'ok' },
      { c: '🤌', k: 'pinched fingers' },
      { c: '🤏', k: 'pinch small' },
      { c: '✌️', k: 'peace victory' },
      { c: '🤞', k: 'fingers crossed' },
      { c: '🤟', k: 'love you gesture' },
      { c: '🤘', k: 'rock horns' },
      { c: '🤙', k: 'call me' },
      { c: '👈', k: 'point left' },
      { c: '👉', k: 'point right' },
      { c: '👆', k: 'point up' },
      { c: '👇', k: 'point down' },
      { c: '☝️', k: 'index up' },
      { c: '✋', k: 'raised hand stop' },
      { c: '🤚', k: 'back of hand' },
      { c: '🖐️', k: 'hand fingers splayed' },
      { c: '🖖', k: 'vulcan' },
      { c: '👏', k: 'clap' },
      { c: '🙌', k: 'raise hands' },
      { c: '👐', k: 'open hands' },
      { c: '🤲', k: 'palms up' },
      { c: '🙏', k: 'pray thanks please' },
      { c: '💪', k: 'muscle strong' },
      { c: '👋', k: 'wave hello' },
      { c: '✍️', k: 'write' },
      { c: '👀', k: 'eyes look' },
      { c: '👁️', k: 'eye' },
      { c: '🫶', k: 'heart hands' },
      { c: '🫡', k: 'salute' },
    ],
  },
  {
    id: 'symbols',
    items: [
      { c: '❤️', k: 'heart love red' },
      { c: '🧡', k: 'orange heart' },
      { c: '💛', k: 'yellow heart' },
      { c: '💚', k: 'green heart' },
      { c: '💙', k: 'blue heart' },
      { c: '💜', k: 'purple heart' },
      { c: '🔥', k: 'fire hot lit' },
      { c: '⭐', k: 'star' },
      { c: '🌟', k: 'star glow' },
      { c: '✨', k: 'sparkles' },
      { c: '⚡', k: 'lightning bolt' },
      { c: '✅', k: 'check done yes' },
      { c: '❌', k: 'cross no error' },
      { c: '⚠️', k: 'warning' },
      { c: '❗', k: 'exclamation' },
      { c: '❓', k: 'question' },
      { c: '💯', k: 'hundred perfect' },
      { c: '🎉', k: 'party tada celebrate' },
      { c: '🎁', k: 'gift present' },
      { c: '🚀', k: 'rocket launch' },
      { c: '💰', k: 'money bag' },
      { c: '💎', k: 'diamond gem' },
      { c: '🔔', k: 'bell notification' },
      { c: '📢', k: 'announce loudspeaker' },
      { c: '📣', k: 'megaphone' },
      { c: '🏆', k: 'trophy win' },
      { c: '🎯', k: 'target goal' },
      { c: '💡', k: 'idea bulb' },
      { c: '📌', k: 'pin' },
      { c: '🔗', k: 'link' },
      { c: '💢', k: 'anger' },
      { c: '💥', k: 'boom collision' },
      { c: '💫', k: 'dizzy' },
      { c: '💦', k: 'sweat drops' },
      { c: '🌀', k: 'cyclone' },
      { c: '🎵', k: 'note music' },
      { c: '🎶', k: 'notes music' },
      { c: '💬', k: 'speech bubble' },
      { c: '💭', k: 'thought bubble' },
      { c: '🔇', k: 'mute' },
      { c: '🔊', k: 'loud' },
      { c: '🔕', k: 'mute bell' },
      { c: '➕', k: 'plus add' },
      { c: '➖', k: 'minus' },
      { c: '➗', k: 'divide' },
      { c: '♾️', k: 'infinity' },
      { c: '‼️', k: 'double exclamation' },
      { c: '⁉️', k: 'exclamation question' },
      { c: '〽️', k: 'part alternation' },
      { c: '🔅', k: 'dim' },
      { c: '🔆', k: 'bright' },
      { c: '🆕', k: 'new' },
      { c: '🆓', k: 'free' },
      { c: '🆗', k: 'ok button' },
      { c: '🆒', k: 'cool button' },
    ],
  },
  {
    id: 'objects',
    items: [
      { c: '📱', k: 'phone mobile device' },
      { c: '💻', k: 'laptop computer' },
      { c: '🖥️', k: 'desktop monitor' },
      { c: '🔒', k: 'lock secure private' },
      { c: '🔓', k: 'unlock open' },
      { c: '🔑', k: 'key' },
      { c: '🛡️', k: 'shield protect vpn' },
      { c: '🌐', k: 'globe world web internet' },
      { c: '📡', k: 'satellite signal' },
      { c: '⚙️', k: 'gear settings' },
      { c: '🔧', k: 'wrench tool fix' },
      { c: '📈', k: 'chart up growth' },
      { c: '📉', k: 'chart down' },
      { c: '📊', k: 'bar chart stats' },
      { c: '🗂️', k: 'folder files' },
      { c: '📅', k: 'calendar date' },
      { c: '⏰', k: 'alarm clock time' },
      { c: '🕐', k: 'clock time' },
      { c: '💳', k: 'card payment credit' },
      { c: '🧾', k: 'receipt invoice' },
      { c: '📦', k: 'box package' },
      { c: '✉️', k: 'email envelope mail' },
      { c: '📨', k: 'incoming mail' },
      { c: '🔋', k: 'battery' },
      { c: '🔌', k: 'plug' },
      { c: '📷', k: 'camera' },
      { c: '🎥', k: 'movie camera' },
      { c: '🎬', k: 'clapper film' },
      { c: '🎮', k: 'game controller' },
      { c: '🕹️', k: 'joystick' },
      { c: '💾', k: 'floppy save' },
      { c: '💿', k: 'cd disk' },
      { c: '🖨️', k: 'printer' },
      { c: '⌨️', k: 'keyboard' },
      { c: '🖱️', k: 'mouse computer' },
      { c: '📞', k: 'phone receiver' },
      { c: '☎️', k: 'telephone' },
      { c: '📟', k: 'pager' },
      { c: '🔍', k: 'search magnify' },
      { c: '🔎', k: 'search right' },
      { c: '💸', k: 'money wings' },
      { c: '🪙', k: 'coin' },
      { c: '💵', k: 'dollar' },
      { c: '🧮', k: 'abacus' },
      { c: '📎', k: 'paperclip' },
      { c: '✂️', k: 'scissors' },
      { c: '🖊️', k: 'pen' },
      { c: '📝', k: 'memo note' },
      { c: '📖', k: 'book open' },
      { c: '📚', k: 'books' },
      { c: '🏷️', k: 'label tag' },
    ],
  },
  {
    id: 'nature-food',
    items: [
      { c: '🌍', k: 'earth globe' },
      { c: '🌙', k: 'moon night' },
      { c: '☀️', k: 'sun' },
      { c: '⛅', k: 'cloud sun' },
      { c: '☁️', k: 'cloud' },
      { c: '🌧️', k: 'rain' },
      { c: '⛈️', k: 'storm' },
      { c: '🌪️', k: 'tornado' },
      { c: '🌊', k: 'wave ocean' },
      { c: '🌈', k: 'rainbow' },
      { c: '🍀', k: 'clover luck' },
      { c: '🌸', k: 'flower blossom' },
      { c: '🌹', k: 'rose' },
      { c: '🌻', k: 'sunflower' },
      { c: '🌴', k: 'palm tree' },
      { c: '🌵', k: 'cactus' },
      { c: '🔥', k: 'fire' },
      { c: '❄️', k: 'snow cold' },
      { c: '⚡', k: 'lightning' },
      { c: '💧', k: 'drop water' },
      { c: '⭐', k: 'star' },
      { c: '🍕', k: 'pizza food' },
      { c: '🍔', k: 'burger' },
      { c: '🍟', k: 'fries' },
      { c: '🌮', k: 'taco' },
      { c: '🍩', k: 'donut' },
      { c: '🍪', k: 'cookie' },
      { c: '☕', k: 'coffee' },
      { c: '🍵', k: 'tea' },
      { c: '🍺', k: 'beer' },
      { c: '🍷', k: 'wine' },
      { c: '🥂', k: 'cheers champagne' },
      { c: '🎂', k: 'cake birthday' },
      { c: '🍿', k: 'popcorn' },
      { c: '🍎', k: 'apple' },
      { c: '🍓', k: 'strawberry' },
    ],
  },
  {
    id: 'animals',
    items: [
      { c: '🐶', k: 'dog' },
      { c: '🐱', k: 'cat' },
      { c: '🦊', k: 'fox' },
      { c: '🐻', k: 'bear' },
      { c: '🐼', k: 'panda' },
      { c: '🐨', k: 'koala' },
      { c: '🦁', k: 'lion' },
      { c: '🐯', k: 'tiger' },
      { c: '🐮', k: 'cow' },
      { c: '🐷', k: 'pig' },
      { c: '🐵', k: 'monkey' },
      { c: '🐔', k: 'chicken' },
      { c: '🐧', k: 'penguin' },
      { c: '🐦', k: 'bird' },
      { c: '🦅', k: 'eagle' },
      { c: '🦉', k: 'owl' },
      { c: '🐺', k: 'wolf' },
      { c: '🐴', k: 'horse' },
      { c: '🦄', k: 'unicorn' },
      { c: '🐝', k: 'bee' },
      { c: '🦋', k: 'butterfly' },
      { c: '🐢', k: 'turtle' },
      { c: '🐍', k: 'snake' },
      { c: '🐙', k: 'octopus' },
      { c: '🐬', k: 'dolphin' },
      { c: '🐳', k: 'whale' },
      { c: '🦈', k: 'shark' },
      { c: '🐉', k: 'dragon' },
    ],
  },
  {
    id: 'travel-activity',
    items: [
      { c: '🚀', k: 'rocket' },
      { c: '✈️', k: 'plane' },
      { c: '🚗', k: 'car' },
      { c: '🚕', k: 'taxi' },
      { c: '🚙', k: 'suv' },
      { c: '🏎️', k: 'race car' },
      { c: '🚲', k: 'bike' },
      { c: '🛴', k: 'scooter' },
      { c: '🚉', k: 'station train' },
      { c: '🚂', k: 'train' },
      { c: '🛳️', k: 'ship' },
      { c: '⚓', k: 'anchor' },
      { c: '🏠', k: 'house home' },
      { c: '🏢', k: 'office building' },
      { c: '🏙️', k: 'city' },
      { c: '🗺️', k: 'map' },
      { c: '🧭', k: 'compass' },
      { c: '⚽', k: 'soccer' },
      { c: '🏀', k: 'basketball' },
      { c: '🏈', k: 'football' },
      { c: '⚾', k: 'baseball' },
      { c: '🎾', k: 'tennis' },
      { c: '🏐', k: 'volleyball' },
      { c: '🎱', k: 'billiards 8 ball' },
      { c: '🏆', k: 'trophy' },
      { c: '🥇', k: 'gold medal' },
      { c: '🥈', k: 'silver medal' },
      { c: '🥉', k: 'bronze medal' },
      { c: '🎮', k: 'gaming' },
      { c: '🎲', k: 'dice' },
      { c: '🎸', k: 'guitar' },
      { c: '🎧', k: 'headphones' },
    ],
  },
]

const ALL_EMOJIS: readonly EmojiEntry[] = EMOJI_GROUPS.flatMap((g) => g.items)

interface CustomEmojiLite {
  readonly slug: string
  readonly name: string
  readonly imageUrl: string
  readonly lottieUrl: string | null
  readonly videoUrl: string | null
}
interface CustomEmojiPackLite {
  readonly id: string
  readonly name: string
  readonly emojis: readonly CustomEmojiLite[]
}

export function EmojiPicker({
  onSelect,
  ariaLabel,
}: {
  readonly onSelect: (emoji: string) => void
  readonly ariaLabel: string
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [tab, setTab] = useState<'standard' | 'custom'>('standard')

  const { data: packs } = useQuery<ReadonlyArray<CustomEmojiPackLite>>({
    queryKey: ['admin', 'custom-emoji', 'packs'],
    queryFn: async () =>
      (await api.get<ReadonlyArray<CustomEmojiPackLite>>('/admin/custom-emoji/packs')).data,
    enabled: open,
    staleTime: 60_000,
  })

  const normalized = query.trim().toLowerCase()
  const filtered = normalized.length > 0
    ? ALL_EMOJIS.filter((e) => e.k.includes(normalized))
    : ALL_EMOJIS

  const hasCustom = (packs?.length ?? 0) > 0

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="h-7 w-7 text-muted-foreground hover:text-foreground"
          aria-label={ariaLabel}
        >
          <Smile className="h-4 w-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 overflow-hidden p-2" align="end">
        {hasCustom && (
          <div className="mb-2 flex gap-1">
            <Button
              type="button"
              size="sm"
              variant={tab === 'standard' ? 'default' : 'outline'}
              className="h-7 flex-1 text-xs"
              onClick={() => setTab('standard')}
            >
              {t('emojiPicker.standard')}
            </Button>
            <Button
              type="button"
              size="sm"
              variant={tab === 'custom' ? 'default' : 'outline'}
              className="h-7 flex-1 text-xs"
              onClick={() => setTab('custom')}
            >
              {t('emojiPicker.custom')}
            </Button>
          </div>
        )}

        {tab === 'standard' || !hasCustom ? (
          <>
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('emojiPicker.search')}
              aria-label={t('emojiPicker.search')}
              className="h-8 mb-2 text-xs"
            />
            <div
              className="grid grid-cols-8 gap-1 max-h-52 overflow-y-auto overflow-x-hidden overscroll-contain"
              onWheelCapture={(e) => e.stopPropagation()}
            >
              {filtered.map((e) => (
                <button
                  type="button"
                  key={e.c}
                  aria-label={e.k}
                  onClick={() => {
                    onSelect(e.c)
                    setOpen(false)
                  }}
                  className="flex aspect-square w-full items-center justify-center rounded text-lg hover:bg-muted"
                >
                  {e.c}
                </button>
              ))}
              {filtered.length === 0 && (
                <p className="col-span-8 py-4 text-center text-xs text-muted-foreground">
                  {t('emojiPicker.empty')}
                </p>
              )}
            </div>
          </>
        ) : (
          <div
            className="max-h-60 space-y-3 overflow-y-auto overflow-x-hidden overscroll-contain"
            onWheelCapture={(e) => e.stopPropagation()}
          >
            {packs?.map((pack) => (
              <div key={pack.id} className="space-y-1" style={{ contentVisibility: 'auto' }}>
                <p className="text-[11px] font-medium text-muted-foreground">{pack.name}</p>
                <div className="grid grid-cols-8 gap-1">
                  {pack.emojis.map((emoji) => (
                    <button
                      type="button"
                      key={emoji.slug}
                      title={`:${emoji.slug}:`}
                      aria-label={emoji.name}
                      onClick={() => {
                        onSelect(`:${emoji.slug}:`)
                        setOpen(false)
                      }}
                      className="flex aspect-square w-full items-center justify-center rounded hover:bg-muted"
                    >
                      {/* Static thumbnail by default; the Lottie/video player
                          mounts only on hover/focus (or selection) so a big
                          pack never spins up hundreds of players at once. */}
                      <EmojiPreview
                        imageUrl={emoji.imageUrl}
                        lottieUrl={emoji.lottieUrl}
                        videoUrl={emoji.videoUrl}
                        alt={emoji.name}
                        playMode="hover"
                        className="h-6 w-6 bg-transparent"
                      />
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
