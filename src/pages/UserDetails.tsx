import { useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowLeft,
  User,
  CreditCard,
  Key,
  Handshake,
  Gift,
  Activity,
  Ban,
  Loader2,
  Shield,
  ShieldAlert,
  Calendar,
  Crown,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Separator } from '@/components/ui/separator';
import { usersService } from '@/api/users.service';
import type { UserDetails } from '@/types/entity.types';

/**
 * User profile tab component
 */
function UserProfile({ userDetails }: { userDetails: UserDetails }): React.ReactElement {
  const { user } = userDetails;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <User className="h-5 w-5" />
            Basic Information
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1">
              <p className="text-sm text-muted-foreground">User ID</p>
              <p className="font-mono text-sm">{user.id}</p>
            </div>
            <div className="space-y-1">
              <p className="text-sm text-muted-foreground">Username</p>
              <p className="font-medium">{user.username}</p>
            </div>
            <div className="space-y-1">
              <p className="text-sm text-muted-foreground">First Name</p>
              <p>{user.firstName || '-'}</p>
            </div>
            <div className="space-y-1">
              <p className="text-sm text-muted-foreground">Last Name</p>
              <p>{user.lastName || '-'}</p>
            </div>
            <div className="space-y-1">
              <p className="text-sm text-muted-foreground">Telegram ID</p>
              <p className="font-mono text-sm">{user.telegramId || '-'}</p>
            </div>
            <div className="space-y-1">
              <p className="text-sm text-muted-foreground">Role</p>
              <Badge variant={user.role === 'admin' ? 'default' : 'secondary'}>
                {user.role === 'admin' ? (
                  <>
                    <Crown className="mr-1 h-3 w-3" />
                    Admin
                  </>
                ) : (
                  'User'
                )}
              </Badge>
            </div>
            <div className="space-y-1">
              <p className="text-sm text-muted-foreground">Status</p>
              <Badge variant={user.isActive ? 'default' : 'destructive'}>
                {user.isActive ? 'Active' : 'Blocked'}
              </Badge>
            </div>
            <div className="space-y-1">
              <p className="text-sm text-muted-foreground">Last Login</p>
              <p>{user.lastLoginAt ? new Date(user.lastLoginAt).toLocaleString() : 'Never'}</p>
            </div>
            <div className="space-y-1">
              <p className="text-sm text-muted-foreground">Created At</p>
              <p>{new Date(user.createdAt).toLocaleString()}</p>
            </div>
            <div className="space-y-1">
              <p className="text-sm text-muted-foreground">Updated At</p>
              <p>{new Date(user.updatedAt).toLocaleString()}</p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * User subscriptions tab component
 */
function UserSubscriptions({ userDetails }: { userDetails: UserDetails }): React.ReactElement {
  const { subscriptions, stats } = userDetails;

  return (
    <div className="space-y-6">
      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Total Subscriptions</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.totalSubscriptions}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Active</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-green-600">{stats.activeSubscriptions}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Expired/Cancelled</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-muted-foreground">
              {stats.totalSubscriptions - stats.activeSubscriptions}
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Subscription History</CardTitle>
        </CardHeader>
        <CardContent>
          {subscriptions.length === 0 ? (
            <p className="text-muted-foreground text-center py-8">No subscriptions found</p>
          ) : (
            <div className="space-y-4">
              {subscriptions.map((sub) => (
                <div
                  key={sub.id}
                  className="flex items-center justify-between p-4 border rounded-lg"
                >
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <p className="font-medium">{sub.planName}</p>
                      <Badge
                        variant={
                          sub.status === 'active'
                            ? 'default'
                            : sub.status === 'expired'
                              ? 'secondary'
                              : 'destructive'
                        }
                      >
                        {sub.status}
                      </Badge>
                    </div>
                    <p className="text-sm text-muted-foreground">
                      {new Date(sub.startDate).toLocaleDateString()} -{' '}
                      {new Date(sub.endDate).toLocaleDateString()}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="font-medium">${sub.planPrice.toFixed(2)}</p>
                    {sub.remnawaveUuid && (
                      <p className="text-xs text-muted-foreground font-mono">
                        {sub.remnawaveUuid.slice(0, 8)}...
                      </p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * User VPN keys tab component
 */
function UserVpnKeys({ userDetails }: { userDetails: UserDetails }): React.ReactElement {
  const activeSubscriptions = userDetails.subscriptions.filter((s) => s.status === 'active');

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Key className="h-5 w-5" />
            VPN Keys
          </CardTitle>
        </CardHeader>
        <CardContent>
          {activeSubscriptions.length === 0 ? (
            <p className="text-muted-foreground text-center py-8">
              No active VPN keys found
            </p>
          ) : (
            <div className="space-y-4">
              {activeSubscriptions.map((sub) => (
                <div
                  key={sub.id}
                  className="flex items-center justify-between p-4 border rounded-lg"
                >
                  <div className="space-y-1">
                    <p className="font-medium">{sub.planName}</p>
                    <p className="text-sm text-muted-foreground">
                      Expires: {new Date(sub.endDate).toLocaleDateString()}
                    </p>
                  </div>
                  <div className="text-right">
                    {sub.remnawaveUuid ? (
                      <div className="space-y-1">
                        <p className="text-xs text-muted-foreground">UUID</p>
                        <p className="font-mono text-sm">{sub.remnawaveUuid}</p>
                      </div>
                    ) : (
                      <p className="text-sm text-muted-foreground">No key generated</p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * User partner tab component
 */
function UserPartner({ userDetails }: { userDetails: UserDetails }): React.ReactElement {
  const { partner, partnerEarnings } = userDetails;

  if (!partner) {
    return (
      <Card>
        <CardContent className="py-12 text-center">
          <Handshake className="mx-auto h-12 w-12 text-muted-foreground mb-4" />
          <p className="text-muted-foreground">This user is not a partner</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Commission Rate</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{partner.commissionRate}%</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Total Earnings</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">${partner.totalEarnings.toFixed(2)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Pending</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-yellow-600">
              ${partner.pendingEarnings.toFixed(2)}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Referrals</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{partner.referralCount}</div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Partner Information</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1">
              <p className="text-sm text-muted-foreground">Referral Code</p>
              <p className="font-mono text-lg">{partner.referralCode}</p>
            </div>
            <div className="space-y-1">
              <p className="text-sm text-muted-foreground">Status</p>
              <Badge
                variant={
                  partner.status === 'active'
                    ? 'default'
                    : partner.status === 'pending'
                      ? 'secondary'
                      : 'destructive'
                }
              >
                {partner.status}
              </Badge>
            </div>
            <div className="space-y-1">
              <p className="text-sm text-muted-foreground">Paid Earnings</p>
              <p className="font-medium">${partner.paidEarnings.toFixed(2)}</p>
            </div>
            <div className="space-y-1">
              <p className="text-sm text-muted-foreground">Joined</p>
              <p>{new Date(partner.createdAt).toLocaleDateString()}</p>
            </div>
          </div>
        </CardContent>
      </Card>

      {partnerEarnings.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Recent Earnings</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {partnerEarnings.slice(0, 5).map((earning) => (
                <div
                  key={earning.id}
                  className="flex items-center justify-between p-3 border rounded"
                >
                  <div>
                    <Badge
                      variant={
                        earning.status === 'paid'
                          ? 'default'
                          : earning.status === 'pending'
                            ? 'secondary'
                            : 'destructive'
                      }
                    >
                      {earning.status}
                    </Badge>
                  </div>
                  <div className="text-right">
                    <p className="font-medium">${earning.amount.toFixed(2)}</p>
                    <p className="text-xs text-muted-foreground">
                      {new Date(earning.createdAt).toLocaleDateString()}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

/**
 * User referrals tab component
 */
function UserReferrals({ userDetails }: { userDetails: UserDetails }): React.ReactElement {
  const { referralsSent, referralsReceived, referralRewards, stats } = userDetails;

  return (
    <div className="space-y-6">
      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Referrals Sent</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.referralsCount}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Rewards Earned</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">${stats.rewardsEarned.toFixed(2)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Has Referrer</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {referralsReceived ? 'Yes' : 'No'}
            </div>
          </CardContent>
        </Card>
      </div>

      {referralsReceived && (
        <Card>
          <CardHeader>
            <CardTitle>Referred By</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-between p-4 border rounded-lg">
              <div className="space-y-1">
                <p className="font-medium">User ID: {referralsReceived.referrerId}</p>
                <p className="text-sm text-muted-foreground">
                  Referred on {new Date(referralsReceived.createdAt).toLocaleDateString()}
                </p>
              </div>
              <div className="text-right">
                <Badge
                  variant={
                    referralsReceived.status === 'completed'
                      ? 'default'
                      : referralsReceived.status === 'active'
                        ? 'secondary'
                        : 'destructive'
                  }
                >
                  {referralsReceived.status}
                </Badge>
                <p className="text-sm mt-1">
                  Reward: ${referralsReceived.referredReward.toFixed(2)}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {referralsSent.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Referrals Made</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {referralsSent.map((referral) => (
                <div
                  key={referral.id}
                  className="flex items-center justify-between p-3 border rounded"
                >
                  <div className="space-y-1">
                    <p className="font-medium">User ID: {referral.referredId}</p>
                    <p className="text-xs text-muted-foreground">
                      {new Date(referral.createdAt).toLocaleDateString()}
                    </p>
                  </div>
                  <div className="text-right">
                    <Badge
                      variant={
                        referral.status === 'completed'
                          ? 'default'
                          : referral.status === 'active'
                            ? 'secondary'
                            : 'destructive'
                      }
                    >
                      {referral.status}
                    </Badge>
                    <p className="text-sm mt-1">
                      Reward: ${referral.referrerReward.toFixed(2)}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {referralRewards.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Reward History</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {referralRewards.slice(0, 5).map((reward) => (
                <div
                  key={reward.id}
                  className="flex items-center justify-between p-3 border rounded"
                >
                  <div>
                    <Badge
                      variant={
                        reward.status === 'paid'
                          ? 'default'
                          : reward.status === 'pending'
                            ? 'secondary'
                            : 'destructive'
                      }
                    >
                      {reward.status}
                    </Badge>
                  </div>
                  <div className="text-right">
                    <p className="font-medium">${reward.amount.toFixed(2)}</p>
                    <p className="text-xs text-muted-foreground">
                      {new Date(reward.createdAt).toLocaleDateString()}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

/**
 * User activity tab component
 */
function UserActivityLog({ userDetails }: { userDetails: UserDetails }): React.ReactElement {
  const { activity } = userDetails;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Activity className="h-5 w-5" />
          Activity Log
        </CardTitle>
      </CardHeader>
      <CardContent>
        {activity.length === 0 ? (
          <p className="text-muted-foreground text-center py-8">
            No activity recorded yet
          </p>
        ) : (
          <div className="space-y-4">
            {activity.map((item) => (
              <div key={item.id} className="flex items-start gap-4 p-4 border rounded-lg">
                <Activity className="h-5 w-5 text-muted-foreground mt-0.5" />
                <div className="flex-1 space-y-1">
                  <p className="font-medium">{item.action}</p>
                  <p className="text-sm text-muted-foreground">
                    {new Date(item.createdAt).toLocaleString()}
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * User blocks tab component
 */
function UserBlocks({ userDetails }: { userDetails: UserDetails }): React.ReactElement {
  const { user } = userDetails;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Ban className="h-5 w-5" />
          Block History
        </CardTitle>
      </CardHeader>
      <CardContent>
        {!user.isActive ? (
          <div className="p-4 border border-destructive rounded-lg bg-destructive/10">
            <div className="flex items-center gap-2 text-destructive">
              <Ban className="h-5 w-5" />
              <p className="font-medium">User is currently blocked</p>
            </div>
          </div>
        ) : (
          <p className="text-muted-foreground text-center py-8">
            User has not been blocked
          </p>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * User details page component
 */
export default function UserDetails(): React.ReactElement {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState('profile');

  const {
    data: userDetails,
    isLoading,
    isError,
    error,
  } = useQuery({
    queryKey: ['user-details', id],
    queryFn: () => usersService.getUserDetails(id!),
    enabled: !!id,
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (isError || !userDetails) {
    return (
      <div className="text-center py-12">
        <p className="text-destructive">Failed to load user details</p>
        <p className="text-sm text-muted-foreground">{(error as Error)?.message}</p>
        <Button variant="outline" className="mt-4" onClick={() => navigate('/users')}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back to Users
        </Button>
      </div>
    );
  }

  const { user, stats } = userDetails;

  const getRoleBadge = (role: string) => {
    if (role === 'admin') {
      return (
        <Badge className="bg-purple-500 hover:bg-purple-600">
          <Crown className="mr-1 h-3 w-3" />
          Admin
        </Badge>
      );
    }
    return <Badge variant="secondary">User</Badge>;
  };

  const getStatusBadge = (isActive: boolean) => {
    if (isActive) {
      return (
        <Badge variant="default" className="bg-green-500">
          <Shield className="mr-1 h-3 w-3" />
          Active
        </Badge>
      );
    }
    return (
      <Badge variant="destructive">
        <ShieldAlert className="mr-1 h-3 w-3" />
        Blocked
      </Badge>
    );
  };

  return (
    <div className="space-y-6">
      {/* Breadcrumbs */}
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Link to="/users" className="hover:text-foreground transition-colors">
          Users
        </Link>
        <span>/</span>
        <span className="text-foreground">{user.username}</span>
      </div>

      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div className="flex items-center gap-4">
          <Button variant="outline" size="icon" onClick={() => navigate('/users')}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div className="flex items-center gap-3">
            <Avatar className="h-12 w-12">
              <AvatarFallback className="text-lg">
                {user.firstName?.[0] || user.username[0].toUpperCase()}
              </AvatarFallback>
            </Avatar>
            <div>
              <h1 className="text-2xl font-bold">{user.username}</h1>
              <div className="flex items-center gap-2 mt-1">
                {getRoleBadge(user.role)}
                {getStatusBadge(user.isActive)}
              </div>
            </div>
          </div>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => navigate(`/users`)}>
            Edit User
          </Button>
        </div>
      </div>

      {/* Quick Stats */}
      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Subscriptions</CardTitle>
            <CreditCard className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.totalSubscriptions}</div>
            <p className="text-xs text-muted-foreground">
              {stats.activeSubscriptions} active
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Partner Status</CardTitle>
            <Handshake className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {userDetails.partner ? 'Yes' : 'No'}
            </div>
            <p className="text-xs text-muted-foreground">
              {userDetails.partner ? `$${stats.partnerEarnings.toFixed(2)} earned` : 'Not a partner'}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Referrals</CardTitle>
            <Gift className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.referralsCount}</div>
            <p className="text-xs text-muted-foreground">
              ${stats.rewardsEarned.toFixed(2)} earned
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Member Since</CardTitle>
            <Calendar className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {new Date(user.createdAt).toLocaleDateString(undefined, {
                month: 'short',
                year: 'numeric',
              })}
            </div>
            <p className="text-xs text-muted-foreground">
              {Math.floor((Date.now() - new Date(user.createdAt).getTime()) / (1000 * 60 * 60 * 24))} days ago
            </p>
          </CardContent>
        </Card>
      </div>

      <Separator />

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
        <TabsList className="grid w-full grid-cols-3 lg:grid-cols-7 lg:w-auto">
          <TabsTrigger value="profile" className="gap-2">
            <User className="h-4 w-4 lg:mr-2" />
            <span className="hidden lg:inline">Profile</span>
          </TabsTrigger>
          <TabsTrigger value="subscriptions" className="gap-2">
            <CreditCard className="h-4 w-4 lg:mr-2" />
            <span className="hidden lg:inline">Subscriptions</span>
          </TabsTrigger>
          <TabsTrigger value="vpn-keys" className="gap-2">
            <Key className="h-4 w-4 lg:mr-2" />
            <span className="hidden lg:inline">VPN Keys</span>
          </TabsTrigger>
          <TabsTrigger value="partner" className="gap-2">
            <Handshake className="h-4 w-4 lg:mr-2" />
            <span className="hidden lg:inline">Partner</span>
          </TabsTrigger>
          <TabsTrigger value="referrals" className="gap-2">
            <Gift className="h-4 w-4 lg:mr-2" />
            <span className="hidden lg:inline">Referrals</span>
          </TabsTrigger>
          <TabsTrigger value="activity" className="gap-2">
            <Activity className="h-4 w-4 lg:mr-2" />
            <span className="hidden lg:inline">Activity</span>
          </TabsTrigger>
          <TabsTrigger value="blocks" className="gap-2">
            <Ban className="h-4 w-4 lg:mr-2" />
            <span className="hidden lg:inline">Blocks</span>
          </TabsTrigger>
        </TabsList>

        <div className="mt-6">
          <TabsContent value="profile">
            <UserProfile userDetails={userDetails} />
          </TabsContent>
          <TabsContent value="subscriptions">
            <UserSubscriptions userDetails={userDetails} />
          </TabsContent>
          <TabsContent value="vpn-keys">
            <UserVpnKeys userDetails={userDetails} />
          </TabsContent>
          <TabsContent value="partner">
            <UserPartner userDetails={userDetails} />
          </TabsContent>
          <TabsContent value="referrals">
            <UserReferrals userDetails={userDetails} />
          </TabsContent>
          <TabsContent value="activity">
            <UserActivityLog userDetails={userDetails} />
          </TabsContent>
          <TabsContent value="blocks">
            <UserBlocks userDetails={userDetails} />
          </TabsContent>
        </div>
      </Tabs>
    </div>
  );
}
