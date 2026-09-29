
import React, { useEffect, useState } from 'react';
import { api } from '../services/api';
import { AdminUser, AdminStats } from '../types';
import { useLanguage } from '../contexts/LanguageContext';
import { Trash2, Plus, Shield, ShieldAlert, User, RefreshCw, Loader2, CheckCircle, DollarSign, Briefcase, FileText } from 'lucide-react';

export const AdminUsersPage: React.FC = () => {
  const { t } = useLanguage();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState<AdminStats | null>(null);

  // Form State
  const [isCreating, setIsCreating] = useState(false);
  const [newEmail, setNewEmail] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newRole, setNewRole] = useState('user');
  const [processing, setProcessing] = useState(false);
  const [msg, setMsg] = useState<{type: 'success' | 'error', text: string} | null>(null);

  const fetchUsers = async () => {
    setLoading(true);
    const res = await api.admin.listUsers();
    if (res.success && res.users) {
      setUsers(res.users);
    } else {
      setMsg({ type: 'error', text: res.error || 'Failed to fetch users' });
    }
    setLoading(false);
  };

  const fetchStats = async () => {
    const res = await api.admin.getStats();
    if (res.success && res.stats) {
      setStats(res.stats);
      // Enrich users with per-user stats
      setUsers(prev => prev.map(u => {
        const userStat = res.stats.perUser.find((p: any) => p.user_id === u.id);
        return userStat ? { ...u, jobsCount: userStat.jobs, appsCount: userStat.applications, costUsd: userStat.cost } : u;
      }));
    }
  };

  useEffect(() => {
    fetchUsers().then(() => fetchStats());
  }, []);

  const handleCreateUser = async (e: React.FormEvent) => {
    e.preventDefault();
    setProcessing(true);
    setMsg(null);

    const res = await api.admin.createUser(newEmail, newPassword, newRole);
    
    if (res.success) {
       setMsg({ type: 'success', text: 'User created successfully!' });
       setIsCreating(false);
       setNewEmail('');
       setNewPassword('');
       fetchUsers();
    } else {
       setMsg({ type: 'error', text: res.error || 'Failed' });
    }
    setProcessing(false);
  };

  const handleDeleteUser = async (userId: string) => {
    if (!confirm('Are you sure? This will delete all their data.')) return;
    
    setMsg(null);
    const res = await api.admin.deleteUser(userId);
    if (res.success) {
       setMsg({ type: 'success', text: 'User deleted.' });
       fetchUsers();
    } else {
       setMsg({ type: 'error', text: res.error || 'Failed' });
    }
  };

  return (
    <div className="max-w-6xl mx-auto animate-fade-in">
      <div className="flex flex-wrap justify-between items-center gap-3 mb-6">
        <div className="min-w-0">
          <h2 className="text-2xl font-bold text-slate-900 flex items-center gap-2"><ShieldAlert className="text-red-600" /> {t('admin.title')}</h2>
          <p className="text-slate-500">{t('admin.subtitle')}</p>
        </div>
        <div className="flex gap-2 shrink-0">
          <button onClick={fetchUsers} className="p-2 bg-white border rounded-lg hover:bg-slate-50 text-slate-600">
             <RefreshCw size={20} className={loading ? "animate-spin" : ""} />
          </button>
          <button onClick={() => setIsCreating(!isCreating)} className="bg-blue-600 text-white px-4 py-2 rounded-lg flex items-center gap-2 whitespace-nowrap hover:bg-blue-700">
             <Plus size={20} /> {t('admin.addUser')}
          </button>
        </div>
      </div>

      {msg && (
        <div className={`p-3 rounded-lg mb-4 text-sm font-medium flex items-center gap-2 ${msg.type === 'success' ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}`}>
           {msg.type === 'success' ? <CheckCircle size={16}/> : <ShieldAlert size={16}/>} {msg.text}
        </div>
      )}

      {stats && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
          <div className="bg-white rounded-xl border border-slate-200 p-4 flex items-center gap-3">
            <div className="bg-green-100 p-3 rounded-full"><DollarSign size={20} className="text-green-600" /></div>
            <div>
              <div className="text-xs text-slate-500 uppercase font-bold">{t('admin.totalAiCost')}</div>
              <div className="text-2xl font-bold text-slate-900">${stats.totalCost.toFixed(2)}</div>
            </div>
          </div>
          <div className="bg-white rounded-xl border border-slate-200 p-4 flex items-center gap-3">
            <div className="bg-blue-100 p-3 rounded-full"><Briefcase size={20} className="text-blue-600" /></div>
            <div>
              <div className="text-xs text-slate-500 uppercase font-bold">{t('admin.totalJobs')}</div>
              <div className="text-2xl font-bold text-slate-900">{stats.totalJobs.toLocaleString()}</div>
            </div>
          </div>
          <div className="bg-white rounded-xl border border-slate-200 p-4 flex items-center gap-3">
            <div className="bg-purple-100 p-3 rounded-full"><FileText size={20} className="text-purple-600" /></div>
            <div>
              <div className="text-xs text-slate-500 uppercase font-bold">{t('admin.totalApps')}</div>
              <div className="text-2xl font-bold text-slate-900">{stats.totalApplications.toLocaleString()}</div>
            </div>
          </div>
        </div>
      )}

      {isCreating && (
        <div className="bg-slate-100 p-6 rounded-xl mb-6 border border-slate-200">
           <h3 className="font-bold mb-4 text-slate-800">Create New User</h3>
           <form onSubmit={handleCreateUser} className="grid grid-cols-1 md:grid-cols-4 gap-4 items-end">
              <div>
                 <label className="text-xs font-bold text-slate-500 uppercase">Email</label>
                 <input required type="email" value={newEmail} onChange={e => setNewEmail(e.target.value)} className="w-full p-2 rounded border" />
              </div>
              <div>
                 <label className="text-xs font-bold text-slate-500 uppercase">Password</label>
                 <input required type="text" value={newPassword} onChange={e => setNewPassword(e.target.value)} className="w-full p-2 rounded border" placeholder="min 6 chars" />
              </div>
              <div>
                 <label className="text-xs font-bold text-slate-500 uppercase">Role</label>
                 <select value={newRole} onChange={e => setNewRole(e.target.value)} className="w-full p-2 rounded border">
                    <option value="user">User</option>
                    <option value="admin">Admin</option>
                 </select>
              </div>
              <button disabled={processing} className="bg-green-600 text-white py-2 px-4 rounded hover:bg-green-700 font-medium">
                 {processing ? <Loader2 className="animate-spin"/> : 'Create User'}
              </button>
           </form>
        </div>
      )}

      <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
         <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 border-b text-xs uppercase text-slate-500">
               <tr>
                  <th className="p-4">Email</th>
                  <th className="p-4">ID</th>
                  <th className="p-4">Role</th>
                  <th className="p-4 text-right">{t('admin.jobs')}</th>
                  <th className="p-4 text-right">{t('admin.apps')}</th>
                  <th className="p-4 text-right">{t('admin.cost')}</th>
                  <th className="p-4">Created</th>
                  <th className="p-4 text-right">Actions</th>
               </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
               {users.map(u => (
                 <tr key={u.id} className="hover:bg-slate-50">
                    <td className="p-4 font-medium">{u.email}</td>
                    <td className="p-4 font-mono text-xs text-slate-500">{u.id}</td>
                    <td className="p-4">
                        <span className={`px-2 py-1 rounded-full text-xs font-bold uppercase ${u.role === 'admin' ? 'bg-red-100 text-red-700' : 'bg-blue-100 text-blue-700'}`}>
                           {u.role}
                        </span>
                    </td>
                    <td className="p-4 text-right text-slate-700 font-medium">{u.jobsCount ?? '-'}</td>
                    <td className="p-4 text-right text-slate-700 font-medium">{u.appsCount ?? '-'}</td>
                    <td className="p-4 text-right text-slate-700 font-medium">{u.costUsd != null ? `$${u.costUsd.toFixed(2)}` : '-'}</td>
                    <td className="p-4 text-slate-500">{new Date(u.created_at).toLocaleDateString()}</td>
                    <td className="p-4 text-right">
                       <button onClick={() => handleDeleteUser(u.id)} className="text-slate-400 hover:text-red-600 p-2">
                          <Trash2 size={16} />
                       </button>
                    </td>
                 </tr>
               ))}
            </tbody>
         </table>
         {!loading && users.length === 0 && <div className="p-8 text-center text-slate-400 italic">No users found.</div>}
      </div>
    </div>
  );
};
