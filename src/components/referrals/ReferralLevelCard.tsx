import { Crown, Users, Star, TrendingUp } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { cn } from '@/lib/utils';

interface ReferralLevelData {
  level: number;
  count: number;
  totalPoints: number;
  pointsPerReferral: number;
}

interface ReferralLevelCardProps {
  levelData: ReferralLevelData;
  className?: string;
}

/**
 * Get level configuration
 */
function getLevelConfig(level: number): {
  title: string;
  description: string;
  color: string;
  bgColor: string;
  icon: React.ReactNode;
} {
  switch (level) {
    case 1:
      return {
        title: 'Прямые рефералы',
        description: 'Пользователи, зарегистрировавшиеся по вашей ссылке',
        color: 'text-yellow-600',
        bgColor: 'bg-yellow-50',
        icon: <Crown className="h-5 w-5" />,
      };
    case 2:
      return {
        title: 'Рефералы 2-го уровня',
        description: 'Рефералы ваших рефералов',
        color: 'text-blue-600',
        bgColor: 'bg-blue-50',
        icon: <Users className="h-5 w-5" />,
      };
    case 3:
      return {
        title: 'Рефералы 3-го уровня',
        description: 'Рефералы рефералов 2-го уровня',
        color: 'text-green-600',
        bgColor: 'bg-green-50',
        icon: <TrendingUp className="h-5 w-5" />,
      };
    default:
      return {
        title: `Уровень ${level}`,
        description: `Рефералы уровня ${level}`,
        color: 'text-gray-600',
        bgColor: 'bg-gray-50',
        icon: <Users className="h-5 w-5" />,
      };
  }
}

/**
 * Format points
 */
function formatPoints(amount: number): string {
  return new Intl.NumberFormat('ru-RU').format(amount);
}

/**
 * ReferralLevelCard component
 * Displays statistics for a specific referral level (POINTS based, not money)
 */
export function ReferralLevelCard({ levelData, className }: ReferralLevelCardProps): React.ReactElement {
  const config = getLevelConfig(levelData.level);

  return (
    <Card className={cn('overflow-hidden', className)}>
      <CardHeader className={cn('pb-2', config.bgColor)}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className={cn('p-2 rounded-lg bg-white/50', config.color)}>
              {config.icon}
            </div>
            <div>
              <CardTitle className={cn('text-base', config.color)}>{config.title}</CardTitle>
              <p className="text-xs text-muted-foreground">{config.description}</p>
            </div>
          </div>
          <div className={cn('text-2xl font-bold', config.color)}>
            +{levelData.pointsPerReferral}
          </div>
        </div>
      </CardHeader>
      <CardContent className="pt-4 space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-1 text-sm text-muted-foreground">
              <Users className="h-4 w-4" />
              <span>Количество</span>
            </div>
            <div className="text-2xl font-bold">{levelData.count}</div>
          </div>
          <div className="space-y-1">
            <div className="flex items-center gap-1 text-sm text-muted-foreground">
              <Star className="h-4 w-4" />
              <span>Баллов получено</span>
            </div>
            <div className="text-2xl font-bold text-green-600">
              {formatPoints(levelData.totalPoints)}
            </div>
          </div>
        </div>

        <div className="space-y-2">
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">Баллов за реферала</span>
            <span className={cn('font-medium', config.color)}>+{levelData.pointsPerReferral} баллов</span>
          </div>
          <Progress 
            value={levelData.totalPoints} 
            max={Math.max(levelData.totalPoints * 1.5, 100)}
            className="h-2"
          />
          <p className="text-xs text-muted-foreground">
            Вы получаете {levelData.pointsPerReferral} баллов за каждого реферала {levelData.level}-го уровня
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

export default ReferralLevelCard;
