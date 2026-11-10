import { useState, useEffect } from 'react';
import { useStore } from '../store';
import { ICON_BUTTON, ICON_BUTTON_SM, BUTTON_SM, BUTTON_SM_GHOST } from './controls';
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
  const cwd = useStore((s) => {
    const conv = s.conversations.find(c => c.id === s.activeConversationId);
    return conv ? conv.cwd : s.cwd;
  });
  const [listError, setListError] = useState('');
  const [skills, setSkills] = useState<SkillInfo[] | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [filter, setFilter] = useState('');
  const [adding, setAdding] = useState(false);
  const [confirmDeletePath, setConfirmDeletePath] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setSkills(null);
    setListError('');
    void (async () => {
      try {
        const api = (window as any).api?.skills;
        if (typeof api?.list !== 'function') throw new Error('技能列表 IPC 不可用');
        const result: unknown = await api.list(cwd || null);
        if (!Array.isArray(result)) throw new Error('技能列表返回格式无效');
        const valid = result.filter((item): item is SkillInfo => !!item && typeof item === 'object'
          && typeof item.name === 'string' && typeof item.description === 'string'
          && typeof item.path === 'string' && ['project', 'global'].includes(item.scope));
        if (!cancelled) setSkills(valid);
      } catch (error) {
        if (!cancelled) {
          setSkills([]);
          setListError(error instanceof Error ? error.message : String(error));
        }
      }
    })();
    return () => { cancelled = true; };
  }, [cwd, refreshKey]);

  const refresh = () => {
    setAdding(false);
    setConfirmDeletePath(null);
    setRefreshKey((k) => k + 1);
  };

  const projectSkills = (skills || []).filter((s) => s.scope === 'project');
  const globalSkills = (skills || []).filter((s) => s.scope === 'global');
  // 仅当名称不可直接插入或存在同名技能时展示完整路径，避免每行都占用两行。
  const nameCounts = new Map<string, number>();
  (skills || []).forEach((skill) => nameCounts.set(skill.name, (nameCounts.get(skill.name) || 0) + 1));
  const needsPath = (skill: SkillInfo) => !/^[\p{L}\p{N}_-]+(?:[:/][\p{L}\p{N}_-]+)*$/u.test(skill.name) || (nameCounts.get(skill.name) || 0) > 1;
  const match = (s: SkillInfo) =>
    (s.name + ' ' + s.description).toLowerCase().includes(filter.trim().toLowerCase());

  return (
    <div className="px-2 pb-2">
      {/* 标题栏 + 操作 */}
      <div className="flex items-center justify-between px-2 py-1.5">
        <span className="font-mono text-2xs uppercase tracking-wider text-text-dim">
          Skills {skills ? `· ${skills.length}` : ''}
        </span>
        <div className="flex items-center gap-1">
          <button
            onClick={() => { setAdding(!adding); setConfirmDeletePath(null); }}
            className={`${ICON_BUTTON} ${adding ? 'bg-bg-lighter text-accent-cyan' : ''}`}
            title="新建技能"
          >
            <Plus className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={refresh}
            className={ICON_BUTTON}
            title="刷新技能列表"
          >
            <RefreshCw className="w-3.5 h-3.5" />
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
      {adding && <AddSkillForm key={cwd} cwd={cwd} onDone={refresh} />}

      {listError && <div role="alert" className="px-3 py-2 text-xs text-accent-red">{listError}</div>}
      {/* 列表 */}
      {skills === null ? (
        <div className="flex items-center justify-center py-6 text-text-dim">
          <Loader2 className="w-4 h-4 animate-spin" />
        </div>
      ) : (skills.length === 0 ? (
        <div className="text-xs text-text-dim px-3 py-4 text-center">
          未找到任何技能
          <div className="mt-1 text-2xs leading-relaxed">
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
              needsPath={needsPath}
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
              needsPath={needsPath}
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

      <div className="px-2 pt-2 font-mono text-2xs leading-relaxed text-text-dim">
        技能来自 ~/.claude/skills 与项目的 .claude/skills
      </div>
    </div>
  );
}

function SkillGroup({ label, icon, skills, confirmDeletePath, setConfirmDeletePath, onRefresh, needsPath }: {
  label: string;
  icon: React.ReactNode;
  skills: SkillInfo[];
  confirmDeletePath: string | null;
  setConfirmDeletePath: (p: string | null) => void;
  onRefresh: () => void;
  needsPath: (skill: SkillInfo) => boolean;
}) {
  if (skills.length === 0) return null;
  return (
    <div>
      <div className="flex items-center gap-1.5 px-2 pb-1">
        {icon}
        <span className="font-mono text-2xs uppercase tracking-wider text-text-muted">{label}</span>
      </div>
      <div className="space-y-1">
        {skills.map((skill) => (
          <SkillItem
            key={skill.path}
            skill={skill}
            confirming={confirmDeletePath === skill.path}
            showPath={needsPath(skill)}
            setConfirming={(v) => setConfirmDeletePath(v ? skill.path : null)}
            onRefresh={onRefresh}
          />
        ))}
      </div>
    </div>
  );
}

function SkillItem({ skill, confirming, setConfirming, onRefresh, showPath }: {
  skill: SkillInfo;
  confirming: boolean;
  setConfirming: (v: boolean) => void;
  onRefresh: () => void;
  showPath: boolean;
}) {
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState('');
  const hasConversation = useStore(s => s.conversations.some(c => c.id === s.activeConversationId));
  const validName = /^[\p{L}\p{N}_-]+(?:[:/][\p{L}\p{N}_-]+)*$/u.test(skill.name);

  const handleDelete = async () => {
    setDeleting(true);
    setError('');
    try {
      const ok = await (window as any).api.skills.delete(skill.path);
      if (ok) onRefresh();
      else setError('删除技能失败');
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div
      className={`w-full px-2.5 py-2 rounded-lg transition-all group ${
        confirming
          ? 'bg-accent-red/10 border border-accent-red/40'
          : 'border border-transparent hover:bg-bg-light'
      }`}
    >
      <div className="grid grid-cols-[14px_minmax(0,1fr)] items-start gap-x-2 gap-y-1.5">
        <Zap
          className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${
            confirming ? 'text-accent-red' : skill.scope === 'project' ? 'text-accent-cyan' : 'text-accent-purple'
          }`}
        />
        <div className="min-w-0">
          {confirming ? (
            <div className="pt-0.5 text-xs font-medium leading-tight text-accent-red">
              删除 {skill.name}？不可恢复
            </div>
          ) : (
            <>
              <div className="flex items-center gap-1.5">
                <span className="truncate font-mono text-xs text-text-primary" title={skill.path}>{skill.name}</span>
              </div>
              <div className="mt-0.5 flex items-center gap-1.5 text-2xs leading-4 text-text-dim" title={skill.description || skill.path}>
                <span className="shrink-0 rounded bg-bg-lighter px-1 text-text-muted">{skill.scope === 'project' ? '项目' : '全局'}</span>
                <span className="line-clamp-1 min-w-0">{skill.description || '无简介'}</span>
              </div>
              {showPath && <div className="truncate font-mono text-2xs leading-4 text-text-dim" title={skill.path}>{skill.path}</div>}
            </>
          )}
        </div>
        {confirming ? (
          <div className="col-start-2 flex min-w-0 items-center justify-end gap-1">
            <button
              onClick={handleDelete}
              disabled={deleting}
              className={`${ICON_BUTTON_SM} text-accent-red hover:text-accent-red`}
              aria-label={`确认删除 ${skill.name}`}
              title="确认删除"
            >
              {deleting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
            </button>
            <button
              onClick={() => setConfirming(false)}
              className={ICON_BUTTON_SM}
              aria-label={`取消删除 ${skill.name}`}
              title="取消"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        ) : (
          <div className="col-start-2 flex min-w-0 items-center justify-end gap-1">
            <button
              type="button"
              disabled={!validName || !hasConversation}
              aria-label={`插入 /${skill.name}`}
              title={validName ? '只插入原生命令，不发送；同名技能由 CLI 解析' : '名称不是有效 CLI 命令，请按路径查看技能'}
              onClick={() => {
                if (validName) useStore.getState().injectText(`/${skill.name} `);
              }}
              className={`${BUTTON_SM_GHOST} mr-auto`}
            ><Plus className="h-3.5 w-3.5" /><span>插入</span></button>
            <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
              <button
                onClick={() => {
                  void (async () => {
                    try { await (window as any).api.skills.reveal(skill.path); }
                    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
                  })();
                }}
                className={ICON_BUTTON_SM}
                aria-label={`在访达中打开 ${skill.name}`}
                title="在访达中打开"
              >
                <FolderOpen className="h-3.5 w-3.5" />
              </button>
              <button
                onClick={() => setConfirming(true)}
                className={`${ICON_BUTTON_SM} hover:text-accent-red`}
                aria-label={`删除技能 ${skill.name}`}
                title="删除技能"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        )}
      </div>
      {error && <div role="alert" className="mt-1 text-2xs text-accent-red break-words">{error}</div>}
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
    try {
      const result = await (window as any).api.skills.create({
        name: name.trim().toLowerCase(),
        description: description.trim(),
        scope,
        cwd: cwd || null,
      });
      if (result?.ok) onDone();
      else setError(result?.error || '创建失败');
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setCreating(false);
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
          className={`flex-1 flex items-center justify-center gap-1 px-2 py-1 rounded-md text-2xs font-mono transition-all disabled:opacity-30 disabled:cursor-not-allowed ${
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
          className={`flex-1 flex items-center justify-center gap-1 px-2 py-1 rounded-md text-2xs font-mono transition-all ${
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
        <div className="text-2xs text-accent-red leading-snug break-all">{error}</div>
      )}
      <div className="flex justify-end gap-1.5">
        <button
          onClick={onDone}
          className={BUTTON_SM_GHOST}
        >
          取消
        </button>
        <button
          onClick={handleCreate}
          disabled={!name.trim() || creating}
          className={BUTTON_SM}
        >
          {creating ? '创建中…' : '创建'}
        </button>
      </div>
    </div>
  );
}
