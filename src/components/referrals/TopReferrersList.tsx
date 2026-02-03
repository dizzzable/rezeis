import { Trophy, Medal, Award, Star, TrendingUp } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

interface TopReferrer {
  userId: string;
  referralCount: number;
  totalPoints: number;
  rank: number;
  username?: string;
  firstName?: string;
  photoUrl?: string;
}

interface TopReferrersListProps {
  topReferrers: TopReferrer[];
  currentUserId?: string;
  className?: string;
}

/**
 * Format points
 */
function formatPoints(amount: number): string {
  return new Intl.NumberFormat('ru-RU').format(amount);
}

/**
 * Get rank icon
 */
function getRankIcon(rank: number): React.ReactNode {
  switch (rank) {
    case 1:
      return <Trophy className="h-5 w-5 text-yellow-500" />;
    case 2:
      return <Medal className="h-5 w-5 text-gray-400" />;
    case 3:
      return <Award className="h-5 w-5 text-amber-600" />;
    default:
      return <Star className="h-4 w-4 text-muted-foreground" />;
  }
}

/**
 * Get rank badge style
 */
function getRankBadge(rank: number): string {
  switch (rank) {
    case 1:
      return 'bg-yellow-100 text-yellow-800 border-yellow-200';
    case 2:
      return 'bg-gray-100 text-gray-800 border-gray-200';
    case 3:
      return 'bg-amber-100 text-amber-800 border-amber-200';
    default:
      return 'bg-muted text-muted-foreground';
  }
}

/**
 * TopReferrersList component
 * Displays top referrers leaderboard
 */
export function TopReferrersList({
  topReferrers,
  currentUserId,
  className,
}: TopReferrersListProps): React.ReactElement {
  const isCurrentUserInTop = topReferrers.some((r) => r.userId === currentUserId);

  return (
    <Card className={className}>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-lg">
            <Trophy className="h-5 w-5 text-yellow-500" />
            Топ рефералов
          </CardTitle>
          <Badge variant="outline" className="text-xs">
            {topReferrers.length} участников
          </Badge>
        </div>
      </CardHeader>
      <CardContent>
        {topReferrers.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">
            <Trophy className="h-12 w-12 mx-auto mb-2 opacity-20" />
            <p>Пока нет данных о топ рефералах</p>
          </div>
        ) : (
          <div className="space-y-2">
            {topReferrers.map((referrer, index) => {
              const isCurrentUser = referrer.userId === currentUserId;
              const displayRank = referrer.rank || index + 1;

              return (
                <div
                  key={referrer.userId}
                  className={cn(
                    'flex items-center gap-3 p-3 rounded-lg transition-colors',
                    isCurrentUser ? 'bg-primary/10 border border-primary/20' : 'hover:bg-muted',
                    displayRank <= 3 && 'bg-gradient-to-r from-transparent to-muted/50'
                  )}
                >
                  {/* Rank */}
                  <div
                    className={cn(
                      'flex h-8 w-8 items-center justify-center rounded-full font-bold text-sm shrink-0',
                      getRankBadge(displayRank)
                    )}
                  >
                    {getRankIcon(displayRank)}
                  </div>

                  {/* Avatar */}
                  <Avatar className="h-10 w-10 shrink-0">
                    <AvatarImage src={referrer.photoUrl} />
                    <AvatarFallback className="text-sm">
                      {(referrer.firstName?.[0] || referrer.username?.[0] || '?').toUpperCase()}
                    </AvatarFallback>
                  </Avatar>

                  {/* Info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium truncate">
                        {referrer.firstName || referrer.username || 'Пользователь'}
                      </span>
                      {isCurrentUser && (
                        <Badge variant="default" className="text-xs">
                          Вы
                        </Badge>
                      )}
                    </div>
                    <div className="flex items-center gap-3 text-sm text-muted-foreground">
                      <span className="flex items-center gap-1">
                        <TrendingUp className="h-3 w-3" />
                        {referrer.referralCount} реф.
                      </span>
                    </div>
                  </div>

                  {/* Points */}
                  <div className="text-right shrink-0">
                    <div className="font-bold text-green-600">
                      {formatPoints(referrer.totalPoints)} баллов
                    </div>
                    <div className="text-xs text-muted-foreground">всего баллов</div>
                  </div>
                </div>
              );
            })}

            {!isCurrentUserInTop && currentUserId && (
              <div className="mt-4 pt-4 border-t">
                <div className="flex items-center gap-3 p-3 rounded-lg bg-primary/5 border border-dashed border-primary/20">
                  <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10">
                    <span className="text-xs font-medium text-primary">?</span>
                  </div>
                  <Avatar className="h-10 w-10 shrink-0">
                    <AvatarFallback className="text-sm bg-primary/10 text-primary">
                      Вы
                    </AvatarFallback>
                  </Avatar>
                  <div className="flex-1">
                    <span className="font-medium">Ваша позиция</span>
                    <p className="text-sm text-muted-foreground">
                      Приглашайте больше друзей, чтобы попасть в топ!
                    </p>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default TopReferrersList;
