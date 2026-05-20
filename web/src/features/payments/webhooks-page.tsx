import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';

export default function WebhooksPage() {
  const navigate = useNavigate();

  useEffect(() => {
    navigate('/payments?tab=webhooks', { replace: true });
  }, [navigate]);

  return null;
}
