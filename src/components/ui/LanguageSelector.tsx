import { useTranslation } from 'react-i18next';
import { Globe } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/stores/auth.store';

/**
 * Language option type
 */
interface Language {
  /** Language code */
  code: string;
  /** Display name */
  name: string;
  /** Flag emoji */
  flag: string;
}

/**
 * Available languages
 */
const languages: Language[] = [
  { code: 'ru', name: 'Русский', flag: '🇷🇺' },
  { code: 'en', name: 'English', flag: '🇬🇧' },
];

/**
 * Language selector component
 * Allows users to switch between available languages
 */
export function LanguageSelector() {
  const { i18n } = useTranslation();
  const { updateLanguage } = useAuth();

  const currentLang = languages.find((lang) => lang.code === i18n.language) || languages[0];

  /**
   * Handle language change
   * @param code - Language code to switch to
   */
  const handleLanguageChange = async (code: string) => {
    await i18n.changeLanguage(code);
    await updateLanguage(code);
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="gap-2">
          <Globe className="h-4 w-4" />
          <span>{currentLang.flag}</span>
          <span className="hidden sm:inline">{currentLang.name}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {languages.map((lang) => (
          <DropdownMenuItem
            key={lang.code}
            onClick={() => void handleLanguageChange(lang.code)}
            className="gap-2"
          >
            <span>{lang.flag}</span>
            <span>{lang.name}</span>
            {i18n.language === lang.code && (
              <span className="ml-auto text-primary">✓</span>
            )}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export default LanguageSelector;