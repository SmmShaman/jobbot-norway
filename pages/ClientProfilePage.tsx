
import React, { useEffect, useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { useLanguage } from '../contexts/LanguageContext';
import { api } from '../services/api';
import { User, CreditCard, Zap, LogOut, Shield, DollarSign, BarChart3 } from 'lucide-react';

export const ClientProfilePage: React.FC = () => {
  const { user, signOut } = useAuth();
  const { t } = useLanguage();
  const [stats, setStats] = useState({ totalCost: 0, totalJobs: 0 });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const loadStats = async () => {
      setLoading(true);
      const cost = await api.getTotalCost();
      // Simple way to get job count for this user
      // Load last 2 months for fast page load
      const sinceDate = new Date();
      sinceDate.setMonth(sinceDate.getMonth() - 2);
      const jobs = await api.getJobs(sinceDate.toISOString());
      setStats({ totalCost: cost, totalJobs: jobs.length });
      setLoading(false);
    };
    loadStats();
  }, []);

  return (
    <div className="max-w-4xl mx-auto animate-fade-in">
      <div className="mb-8">
        <h2 className="text-2xl font-bold text-slate-900">{t('profile.title')}</h2>
        <p className="text-slate-500">{t('profile.subtitle')}</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {/* User Info Card */}
        <div className="md:col-span-2 space-y-6">
          <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
            <div className="bg-slate-50 p-6 border-b border-slate-100 flex items-center gap-4">
              <div className="w-16 h-16 bg-blue-100 rounded-full flex items-center justify-center text-blue-600">
                <User size={32} />
              </div>
              <div>
                <h3 className="text-lg font-bold text-slate-800">{user?.email}</h3>
                <span className="inline-block bg-green-100 text-green-700 text-xs px-2 py-0.5 rounded-full font-medium border border-green-200 mt-1">
                  {t('profile.activePlan')}
                </span>
              </div>
            </div>
            <div className="p-6 space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-xs font-bold text-slate-500 uppercase">{t('profile.userId')}</label>
                  <p className="text-sm font-mono text-slate-700 bg-slate-50 p-2 rounded border border-slate-100 truncate">
                    {user?.id}
                  </p>
                </div>
                <div>
                  <label className="text-xs font-bold text-slate-500 uppercase">{t('profile.lastLogin')}</label>
                  <p className="text-sm text-slate-700 p-2">
                    {new Date(user?.last_sign_in_at || '').toLocaleDateString()}
                  </p>
                </div>
              </div>
              
              <div className="pt-4 border-t border-slate-100">
                <button 
                    onClick={signOut} 
                    className="text-red-600 hover:bg-red-50 px-4 py-2 rounded-lg text-sm font-medium flex items-center gap-2 transition-colors w-full justify-center md:justify-start"
                >
                    <LogOut size={16} /> {t('profile.logout')}
                </button>
              </div>
            </div>
          </div>

          {/* Usage Stats */}
          <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-6">
            <h3 className="font-bold text-slate-800 mb-4 flex items-center gap-2">
                <BarChart3 size={20} className="text-slate-400"/> {t('profile.usageStats')}
            </h3>
            <div className="grid grid-cols-2 gap-4">
                <div className="bg-blue-50 p-4 rounded-xl border border-blue-100">
                    <div className="text-blue-600 mb-1"><Zap size={20}/></div>
                    <div className="text-2xl font-bold text-slate-900">{stats.totalJobs}</div>
                    <div className="text-xs text-slate-500">{t('profile.jobsScanned')}</div>
                </div>
                <div className="bg-emerald-50 p-4 rounded-xl border border-emerald-100">
                    <div className="text-emerald-600 mb-1"><DollarSign size={20}/></div>
                    <div className="text-2xl font-bold text-slate-900">${stats.totalCost.toFixed(3)}</div>
                    <div className="text-xs text-slate-500">{t('profile.costIncurred')}</div>
                </div>
            </div>
          </div>
        </div>

        {/* Plan / Subscription Info (Mock) */}
        <div className="bg-slate-900 text-white rounded-xl shadow-lg p-6 flex flex-col h-fit">
           <div className="flex items-center gap-2 mb-6">
              <Shield className="text-blue-400" size={24} />
              <h3 className="font-bold text-lg">Pro Plan</h3>
           </div>
           
           <div className="space-y-4 flex-1">
              <div className="flex items-center justify-between text-sm border-b border-slate-700 pb-2">
                  <span className="text-slate-400">Status</span>
                  <span className="text-green-400 font-medium">Active</span>
              </div>
              <div className="flex items-center justify-between text-sm border-b border-slate-700 pb-2">
                  <span className="text-slate-400">Renewal</span>
                  <span>Dec 22, 2025</span>
              </div>
              <div className="flex items-center justify-between text-sm border-b border-slate-700 pb-2">
                  <span className="text-slate-400">Payment</span>
                  <span className="flex items-center gap-1"><CreditCard size={14}/> •••• 4242</span>
              </div>
           </div>

           <button className="mt-8 w-full bg-blue-600 hover:bg-blue-700 py-2 rounded-lg font-medium text-sm transition-colors">
               Manage Subscription
           </button>
        </div>
      </div>
    </div>
  );
};
