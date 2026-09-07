import { useState, useEffect } from 'react';
import { useStore } from '../store';
import {
  Zap, RefreshCw, Loader2, Search, Plus, Trash2, Check, X,
  FolderOpen, Globe, FolderGit2,
} from 'lucide-react';

interface SkillInfo {
  name: string;
  description: string;
  path: string;
  scope: 'project' | 'global';
}

export function SkillList() {
  const cwd = useStore((s) => s.cwd);
  const [skills, setSkills] = useState<SkillInfo[] | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [filter, setFilter] = useState('');
  const [adding, setAdding] = useState(false);
  const [confirmDeletePath, setConfirmDeletePath] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setSkills(null);
    (window as any).api.skills.list(cwd || null).then((result: SkillInfo[]) => {
      if (!cancelled) setSkills(result);
    });
    return () => { cancelled = true; };
  }, [cwd, refreshKey]);

  const refresh = () => {
    setAdding(false);
    setConfirmDeletePath(null);
    setRefreshKey((k) => k + 1);
  };

  const projectSkills = (skills || []).filter((s) => s.scope === 'project');
  const globalSkills = (skills || []).filter((s) => s.scope === 'global');
  const match = (s: SkillInfo) =>
    (s.name + ' ' + s.description).toLowerCase().includes(filter.trim().toLowerCase());

  return (
    <div className="px-2 pb-2">
      {/* 标题栏 + 操作 */}
      <div className="flex items-center justify-between px-2 py-1.5">
        <span className="text-[10px] text-text-dim font-mono uppercase tracking-wider">
          Skills {skills ? `· ${skills.length}` : ''}
        </span>
        <div className="flex items-center gap-1">
          <button
            onClick={() => { setAdding(!adding); setConfirmDeletePath(null); }}
            className={`transition-colors ${adding ? 'text-accent-cyan' : 'text-text-dim hover:text-accent-cyan'}`}
            title="新建技能"
          >
            <Plus className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={refresh}
            className="text-text-dim hover:text-accent-cyan transition-colors"
            title="刷新技能列表"
          >
            <RefreshCw className="w-3 h-3" />
          </button>
        </div>
      </div>

      {/* 搜索框 */}
      <div className="relative px-1 pb-2">
        <Search className="absolute left-3 top-1/2 -translate-y-[calc(50%+4px)] w-3 h-3 text-text-dim pointer-events-none" />
        <input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="搜索技能…"
          className="w-full pl-7 pr-2 py-1.5 rounded-lg bg-bg-light border border-border text-xs text-text-primary placeholder-text-dim font-mono focus:border-accent-cyan/50 transition-colors"
        />
      </div>

      {/* 新建表单 */}
      {adding && <AddSkillForm cwd={cwd} onDone={refresh} />}

      {/* 列表 */}
      {skills === null ? (
        <div className="flex items-center justify-center py-6 text-text-dim">
          <Loader2 className="w-4 h-4 animate-spin" />
        </div>
      ) : (skills.length === 0 ? (
        <div className="text-xs text-text-dim px-3 py-4 text-center">
          未找到任何技能
          <div className="text-[10px] mt-1 leading-relaxed">
            点击右上角 + 新建，或将技能包放入<br />~/.claude/skills/
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          {projectSkills.length > 0 && (
            <SkillGroup
              label="项目技能"
              icon={<FolderGit2 className="w-3 h-3 text-accent-cyan/70" />}
              skills={projectSkills.filter(match)}
              confirmDeletePath={confirmDeletePath}
              setConfirmDeletePath={setConfirmDeletePath}
              onRefresh={refresh}
            />
          )}
          {globalSkills.length > 0 && (
            <SkillGroup
              label="全局技能"
              icon={<Globe className="w-3 h-3 text-accent-purple/70" />}
              skills={globalSkills.filter(match)}
              confirmDeletePath={confirmDeletePath}
              setConfirmDeletePath={setConfirmDeletePath}
              onRefresh={refresh}
            />
          )}
          {projectSkills.filter(match).length + globalSkills.filter(match).length === 0 && (
            <div className="text-xs text-text-dim px-3 py-4 text-center">无匹配结果</div>
          )}
        </div>
      ))}

      <div className="text-[10px] text-text-dim/60 font-mono px-2 pt-2 leading-relaxed">
        技能来自 ~/.claude/skills 与项目的 .claude/skills
      </div>
    </div>
  );
}

function SkillGroup({ label, icon, skills, confirmDeletePath, setConfirmDeletePath, onRefresh }: {
  label: string;
  icon: React.ReactNode;
  skills: SkillInfo[];
  confirmDeletePath: string | null;
  setConfirmDeletePath: (p: string | null) => void;
  onRefresh: () => void;
}) {
  if (skills.length === 0) return null;
  return (
    <div>
      <div className="flex items-center gap-1.5 px-2 pb-1">
        {icon}
        <span className="text-[10px] text-text-muted font-mono uppercase tracking-wider">{label}</span>
      </div>
      <div className="space-y-1">
        {skills.map((skill) => (
          <SkillItem
            key={skill.path}
            skill={skill}
            confirming={confirmDeletePath === skill.path}
            setConfirming={(v) => setConfirmDeletePath(v ? skill.path : null)}
            onRefresh={onRefresh}
          />
        ))}
      </div>
    </div>
  );
}

function SkillItem({ skill, confirming, setConfirming, onRefresh }: {
  skill: SkillInfo;
  confirming: boolean;
  setConfirming: (v: boolean) => void;
  onRefresh: () => void;
}) {
  const [deleting, setDeleting] = useState(false);

  const handleDelete = async () => {
    setDeleting(true);
    const ok = await (window as any).api.skills.delete(skill.path);
    setDeleting(false);
    if (ok) onRefresh();
  };

  return (
    <div
      className={`w-full px-2.5 py-2 rounded-lg transition-all group ${
        confirming
          ? 'bg-red-500/10 border border-red-500/40'
          : 'border border-transparent hover:bg-bg-light'
      }`}
    >
      <div className="flex items-start gap-2">
        <Zap
          className={`w-3.5 h-3.5 shrink-0 mt-0.5 ${
            confirming ? 'text-red-400' : skill.scope === 'project' ? 'text-accent-cyan' : 'text-accent-purple'
          }`}
        />
        <div className="flex-1 min-w-0">
          {confirming ? (
            <div className="text-xs text-red-300 font-medium leading-tight pt-0.5">
              删除 {skill.name}？不可恢复
            </div>
          ) : (
            <>
              <div className="text-xs text-text-primary truncate font-mono">{skill.name}</div>
              {skill.description && (
                <div className="text-[10px] text-text-dim leading-snug mt-0.5 line-clamp-2" title={skill.description}>
                  {skill.description}
                </div>
              )}
            </>
          )}
        </div>
        {confirming ? (
          <div className="flex items-center gap-1 shrink-0 mt-0.5">
            <button
              onClick={handleDelete}
              disabled={deleting}
              className="text-red-400 hover:text-red-300 transition-colors disabled:opacity-40"
              title="确认删除"
            >
              {deleting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
            </button>
            <button
              onClick={() => setConfirming(false)}
              className="text-text-dim hover:text-text-primary transition-colors"
              title="取消"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-1 shrink-0 mt-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
            <button
              onClick={() => (window as any).api.skills.reveal(skill.path)}
              className="text-text-dim hover:text-accent-cyan transition-colors"
              title="在访达中打开"
            >
              <FolderOpen className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => setConfirming(true)}
              className="text-text-dim hover:text-red-400 transition-colors"
              title="删除技能"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function AddSkillForm({ cwd, onDone }: { cwd: string; onDone: () => void }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [scope, setScope] = useState<'project' | 'global'>(cwd ? 'project' : 'global');
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);

  const handleCreate = async () => {
    if (creating) return;
    setCreating(true);
    setError('');
    const result = await (window as any).api.skills.create({
      name: name.trim().toLowerCase(),
      description: description.trim(),
      scope,
      cwd: cwd || null,
    });
    setCreating(false);
    if (result?.ok) {
      onDone();
    } else {
      setError(result?.error || '创建失败');
    }
  };

  return (
    <div className="mx-1 mb-2 p-2 rounded-lg bg-bg-light border border-accent-cyan/20 space-y-2 animate-fade-in">
      <input
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="技能名（如 my-skill）"
        className="w-full px-2 py-1.5 rounded-md bg-bg-deep border border-border text-xs text-text-primary placeholder-text-dim font-mono focus:border-accent-cyan/50 transition-colors"
      />
      <textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="简介（写清何时使用，帮助模型触发）"
        rows={2}
        className="w-full px-2 py-1.5 rounded-md bg-bg-deep border border-border text-xs text-text-primary placeholder-text-dim focus:border-accent-cyan/50 transition-colors resize-none"
      />
      {/* 作用域选择 */}
      <div className="flex gap-1">
        <button
          onClick={() => setScope('project')}
          disabled={!cwd}
          className={`flex-1 flex items-center justify-center gap-1 px-2 py-1 rounded-md text-[10px] font-mono transition-all disabled:opacity-30 disabled:cursor-not-allowed ${
            scope === 'project'
              ? 'bg-accent-cyan/10 border border-accent-cyan/40 text-accent-cyan'
              : 'border border-border text-text-muted hover:text-text-primary'
          }`}
        >
          <FolderGit2 className="w-3 h-3" />
          项目
        </button>
        <button
          onClick={() => setScope('global')}
          className={`flex-1 flex items-center justify-center gap-1 px-2 py-1 rounded-md text-[10px] font-mono transition-all ${
            scope === 'global'
              ? 'bg-accent-purple/10 border border-accent-purple/40 text-accent-purple'
              : 'border border-border text-text-muted hover:text-text-primary'
          }`}
        >
          <Globe className="w-3 h-3" />
          全局
        </button>
      </div>
      {error && (
        <div className="text-[10px] text-red-400 leading-snug break-all">{error}</div>
      )}
      <div className="flex justify-end gap-1.5">
        <button
          onClick={onDone}
          className="px-2.5 py-1 rounded-md text-[11px] text-text-muted hover:text-text-primary transition-colors"
        >
          取消
        </button>
        <button
          onClick={handleCreate}
          disabled={!name.trim() || creating}
          className="px-2.5 py-1 rounded-md text-[11px] bg-accent-cyan/20 hover:bg-accent-cyan/30 border border-accent-cyan/40 text-accent-cyan transition-all disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {creating ? '创建中…' : '创建'}
        </button>
      </div>
    </div>
  );
}
