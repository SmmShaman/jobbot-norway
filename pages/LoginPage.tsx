
import React, { useState } from 'react';
import { useLanguage } from '../contexts/LanguageContext';
import { Bot, Loader2, Mail, Lock, ArrowRight, AlertCircle } from 'lucide-react';

const SUPABASE_URL = 'https://db-jobbot.vitalii.no';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImlzcyI6InN1cGFiYXNlIiwiaWF0IjoxNzAwMDAwMDAwLCJleHAiOjIwMDAwMDAwMDB9.4uAt57Hq0Sw9CqmqB64PkwdD1yhX8k7-c8R6DArZTls';

export const LoginPage: React.FC = () => {
  const { t } = useLanguage();
  const [loading, setLoading] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isSignUp, setIsSignUp] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const handleAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setMessage(null);

    try {
      const endpoint = isSignUp ? 'signup' : 'token?grant_type=password';
      console.log(`[Login] Attempting ${isSignUp ? 'signup' : 'login'} for ${email}...`);

      const response = await fetch(`${SUPABASE_URL}/auth/v1/${endpoint}`, {
        method: 'POST',
        headers: {
          'apikey': SUPABASE_ANON_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ email, password }),
      });

      const data = await response.json();
      console.log(`[Login] Response: ${response.status}`, data);

      if (!response.ok) {
        throw new Error(data.error_description || data.msg || data.error || 'Authentication failed');
      }

      if (isSignUp) {
        setMessage(t('login.checkEmail'));
      } else {
        // Store session in localStorage (same format as Supabase client)
        const sessionData = {
          access_token: data.access_token,
          refresh_token: data.refresh_token,
          expires_at: data.expires_at,
          expires_in: data.expires_in,
          token_type: data.token_type,
          user: data.user,
        };
        localStorage.setItem('sb-db-jobbot-auth-token', JSON.stringify(sessionData));
        console.log('[Login] Session stored, reloading page...');
        // Reload to pick up the new session
        window.location.reload();
      }
    } catch (err: any) {
      console.error('[Login] Error:', err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col items-center justify-center p-4">
      <div className="w-full max-w-md bg-white rounded-2xl shadow-xl border border-slate-100 overflow-hidden">
        {/* Header */}
        <div className="bg-slate-900 p-8 text-center">
          <div className="w-12 h-12 bg-blue-600 rounded-xl flex items-center justify-center mx-auto mb-4 shadow-lg shadow-blue-900/50">
            <Bot className="text-white" size={28} />
          </div>
          <h1 className="text-2xl font-bold text-white mb-1">JobBot Norway</h1>
          <p className="text-slate-400 text-sm">{t('login.subtitle')}</p>
        </div>

        {/* Form */}
        <div className="p-8">
          <div className="flex gap-4 mb-6 bg-slate-50 p-1 rounded-lg">
            <button
              onClick={() => { setIsSignUp(false); setError(null); setMessage(null); }}
              className={`flex-1 py-2 text-sm font-medium rounded-md transition-all ${
                !isSignUp ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              {t('login.signIn')}
            </button>
            <button
              onClick={() => { setIsSignUp(true); setError(null); setMessage(null); }}
              className={`flex-1 py-2 text-sm font-medium rounded-md transition-all ${
                isSignUp ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              {t('login.signUp')}
            </button>
          </div>

          {error && (
            <div className="bg-red-50 text-red-600 p-3 rounded-lg text-sm flex items-start gap-2 mb-4">
              <AlertCircle size={16} className="mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {message && (
            <div className="bg-green-50 text-green-700 p-3 rounded-lg text-sm flex items-start gap-2 mb-4">
              <Bot size={16} className="mt-0.5 shrink-0" />
              <span>{message}</span>
            </div>
          )}

          <form onSubmit={handleAuth} className="space-y-4">
            <div className="space-y-1">
              <label className="text-xs font-bold text-slate-500 uppercase ml-1">{t('login.email')}</label>
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full pl-10 pr-4 py-2.5 bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:bg-white transition-all"
                  placeholder="name@example.com"
                />
              </div>
            </div>

            <div className="space-y-1">
              <label className="text-xs font-bold text-slate-500 uppercase ml-1">{t('login.password')}</label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
                <input
                  type="password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full pl-10 pr-4 py-2.5 bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:bg-white transition-all"
                  placeholder="••••••••"
                />
              </div>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full bg-blue-600 hover:bg-blue-700 text-white font-bold py-3 rounded-lg shadow-lg shadow-blue-200 transition-all flex items-center justify-center gap-2 mt-6"
            >
              {loading ? <Loader2 className="animate-spin" size={20} /> : (
                <>
                  {isSignUp ? t('login.createAccount') : t('login.loginBtn')}
                  <ArrowRight size={18} />
                </>
              )}
            </button>
          </form>
        </div>
      </div>
      <div className="mt-8 text-slate-400 text-xs text-center">
        &copy; 2025 JobBot Norway. All rights reserved.
      </div>
    </div>
  );
};
