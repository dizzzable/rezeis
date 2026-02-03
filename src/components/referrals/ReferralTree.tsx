import { useState } from 'react';
import { ChevronDown, ChevronRight, User, Crown, Award, Star } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

interface ReferralNode {
  id: string;
  userId: string;
  username?: string;
  firstName?: string;
  photoUrl?: string;
  level: number;
  earnings: number;
  status: 'active' | 'completed' | 'cancelled';
  joinedAt: string;
  children?: ReferralNode[];
}

interface ReferralTreeProps {
  referrals: ReferralNode[];
  maxLevel?: number;
  className?: string;
}

/**
 * Get level icon and color
 */
function getLevelStyle(level: number): { icon: React.ReactNode; color: string; bgColor: string } {
  switch (level) {
    case 1:
      return {
        icon: <Crown className="h-4 w-4" />,
        color: 'text-yellow-600',
        bgColor: 'bg-yellow-100',
      };
    case 2:
      return {
        icon: <Award className="h-4 w-4" />,
        color: 'text-blue-600',
        bgColor: 'bg-blue-100',
      };
    case 3:
      return {
        icon: <Star className="h-4 w-4" />,
        color: 'text-green-600',
        bgColor: 'bg-green-100',
      };
    default:
      return {
        icon: <User className="h-4 w-4" />,
        color: 'text-gray-600',
        bgColor: 'bg-gray-100',
      };
  }
}

/**
 * Format currency
 */
function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('ru-RU', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
  }).format(amount);
}

/**
 * Tree node component
 */
function TreeNode({ node, depth = 0 }: { node: ReferralNode; depth?: number }): React.ReactElement {
  const [isExpanded, setIsExpanded] = useState(depth < 1);
  const hasChildren = node.children && node.children.length > 0;
  const levelStyle = getLevelStyle(node.level);

  const handleToggle = (): void => {
    if (hasChildren) {
      setIsExpanded(!isExpanded);
    }
  };

  return (
    <div className="select-none">
      <div
        className={cn(
          'flex items-center gap-2 p-2 rounded-lg transition-colors hover:bg-muted cursor-pointer',
          depth > 0 && 'ml-4 border-l-2 border-muted pl-4'
        )}
        onClick={handleToggle}
        style={{ marginLeft: `${depth * 16}px` }}
      >
        {hasChildren ? (
          isExpanded ? (
            <ChevronDown className="h-4 w-4 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
          )
        ) : (
          <span className="w-4" />
        )}

        <div className={cn('flex h-8 w-8 items-center justify-center rounded-full', levelStyle.bgColor, levelStyle.color)}>
          {node.photoUrl ? (
            <img
              src={node.photoUrl}
              alt={node.firstName || 'User'}
              className="h-8 w-8 rounded-full object-cover"
            />
          ) : (
            levelStyle.icon
          )}
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium truncate">
              {node.firstName || node.username || 'Пользователь'}
            </span>
            <Badge variant={node.status === 'completed' ? 'default' : 'secondary'} className="text-xs">
              {node.level} ур.
            </Badge>
          </div>
          <div className="text-xs text-muted-foreground">
            {new Date(node.joinedAt).toLocaleDateString('ru-RU')}
          </div>
        </div>

        <div className="text-right">
          <div className="font-medium text-green-600">{formatCurrency(node.earnings)}</div>
          <div className="text-xs text-muted-foreground">заработок</div>
        </div>
      </div>

      {isExpanded && hasChildren && (
        <div className="mt-1">
          {node.children!.map((child) => (
            <TreeNode key={child.id} node={child} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * ReferralTree component
 * Displays hierarchical referral structure
 */
export function ReferralTree({ referrals, maxLevel: _maxLevel = 3, className }: ReferralTreeProps): React.ReactElement {
  const totalEarnings = referrals.reduce((sum, ref) => sum + ref.earnings, 0);
  const byLevel = referrals.reduce(
    (acc, ref) => {
      acc[ref.level] = (acc[ref.level] || 0) + 1;
      return acc;
    },
    {} as Record<number, number>
  );

  return (
    <Card className={className}>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg">Древо рефералов</CardTitle>
          <div className="flex gap-2">
            {[1, 2, 3].map((level) => (
              <Badge key={level} variant="outline" className="text-xs">
                {level} ур.: {byLevel[level] || 0}
              </Badge>
            ))}
          </div>
        </div>
        <div className="text-sm text-muted-foreground">
          Общий заработок: <span className="font-medium text-green-600">{formatCurrency(totalEarnings)}</span>
        </div>
      </CardHeader>
      <CardContent className="max-h-[500px] overflow-y-auto">
        {referrals.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">
            У вас пока нет рефералов
          </div>
        ) : (
          <div className="space-y-1">
            {referrals.map((referral) => (
              <TreeNode key={referral.id} node={referral} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default ReferralTree;
