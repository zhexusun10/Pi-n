import { t } from "../i18n";
import React, { useState } from "react";
import { AnimatePresence } from "motion/react";
import type { Config, ThinkingLevel } from "../types";
import type { ProviderCatalog } from "../services/providerAuth";
import { availableCatalogModels, modelRoles, normalizeModelThinkingLevels, roleModelConfig, thinkingLevelLabel, updateRoleModelConfig } from "../modelConfig";
import { ScopedModelsModal } from "./modals/ScopedModelsModal";

export function RoleModelSettings({ config, setConfig, catalog, envOverrides = {}, busy }: {
  config: Config;
  setConfig: React.Dispatch<React.SetStateAction<Config>>;
  catalog?: ProviderCatalog;
  envOverrides?: Record<string, string>;
  busy: boolean;
}) {
  const [scopedModelsOpen, setScopedModelsOpen] = useState(false);
  const isHidden = (key: string) => catalog?.hiddenModels?.includes(key) || catalog?.models.some(model => `${model.provider}/${model.id}` === key && model.hidden);
  const displayModel = (key: string) => isHidden(key) ? t("当前已选模型已隐藏") : key;
  const draft = normalizeModelThinkingLevels(config, catalog);
  const availableModels = availableCatalogModels(catalog);

  return (
    <div className="role-model-settings">
      <AnimatePresence>
        {scopedModelsOpen && <ScopedModelsModal key="scoped-models-modal" onClose={() => setScopedModelsOpen(false)} />}
      </AnimatePresence>
      {!catalog && <p className="role-model-note" role="status">{busy ? t("正在加载可用模型…") : t("模型列表暂不可用，请在上方刷新 Provider 状态。")}</p>}
      {catalog && availableModels.length === 0 && <p className="role-model-note" role="status">{catalog.models.some(model => model.available)
        ? t("所有可用模型均已隐藏，可在管理可见模型中恢复显示。")
        : t("暂无可用模型，请先在上方登录 Provider 或绑定 API Key，然后刷新状态。")}</p>}
      {modelRoles.map(role => {
        const selected = draft.roleModels?.[role.id];
        const model = selected?.model ?? (role.id === "nodeAgent" ? draft.model : "");
        const settings = roleModelConfig(draft, role.id);
        const effective = roleModelConfig(draft, role.id, envOverrides);
        // Capabilities follow the saved/inherited model, not an environment
        // override that cannot be edited in this form.
        const thinkingModel = catalog?.models.find(item => `${item.provider}/${item.id}` === settings.model);
        const levels = thinkingModel?.thinkingLevels ?? [];
        const supported = levels.includes(settings.thinkingLevel);
        const override = envOverrides[role.id] || envOverrides[`${role.id}Thinking`];
        const currentModel = availableModels.find(item => `${item.provider}/${item.id}` === model);
        const hidden = isHidden(effective.model);
        const unavailable = !!catalog && !!effective.model && !hidden && !availableModels.some(item => `${item.provider}/${item.id}` === effective.model);
        return (
          <section className="role-model-group" key={role.id} aria-label={t("{0} 模型配置", role.label)}>
            <h5>{role.label}</h5>
            <p>{role.description}</p>
            <div className="form-grid">
              <label className="form-field">
                <span>{t("模型")}</span>
                <select value={model} onChange={event => {
                  const value = event.target.value;
                  if (!value || availableModels.some(item => `${item.provider}/${item.id}` === value)) {
                    setConfig(prev => normalizeModelThinkingLevels(updateRoleModelConfig(prev, role.id, { model: value }), catalog));
                  }
                }} className="provider-filter-select" disabled={busy || !catalog || availableModels.length === 0}>
                  <option value="">{role.id === "nodeAgent" ? t("请选择可用模型") : t("使用 Node 默认模型")}</option>
                  {model && !currentModel && <option value={model} disabled>{isHidden(model) ? t("当前已选模型已隐藏") : `${catalog ? t("已选模型不可用：") : t("当前模型：")}${model}`}</option>}
                  {availableModels.map(item => <option key={`${item.provider}/${item.id}`} value={`${item.provider}/${item.id}`}>{item.name || item.id} ({item.provider}/{item.id})</option>)}
                </select>
              </label>
              <label className="form-field">
                <span>{t("思维等级")}</span>
                <select value={settings.thinkingLevel} disabled={busy || levels.length <= 1} onChange={event => {
                  const value = event.target.value as ThinkingLevel;
                  if (levels.includes(value)) {
                    setConfig(prev => normalizeModelThinkingLevels(updateRoleModelConfig(prev, role.id, { thinkingLevel: value }), catalog));
                  }
                }} className="provider-filter-select">
                  {!supported && <option value={settings.thinkingLevel} disabled>{thinkingLevelLabel(settings.thinkingLevel)}</option>}
                  {levels.map(value => <option key={value} value={value}>{thinkingLevelLabel(value)}</option>)}
                </select>
              </label>
            </div>
            {(override || !effective.model) && (
              <small className="role-model-warning">
                {override
                  ? `${t("环境变量覆盖：")}${effective.model ? `${displayModel(effective.model)} · ${effective.thinkingLevel}` : t("未设置模型")}`
                  : t("未设置模型")}
              </small>
            )}
            {hidden && <small className="role-model-warning">{t("已选模型被全局隐藏；现有配置保持不变，可在管理可见模型中恢复显示。")}</small>}
            {unavailable && <small className="role-model-warning">{t("当前使用的模型不可用，请先认证对应 Provider 或重新选择可用模型。")}</small>}
            {role.id === "nodeAgent" && (envOverrides.merger || envOverrides.mergerThinking) && (
              <small className="role-model-warning">
                {t("Merger 环境变量覆盖：")}{envOverrides.merger?.trim() || effective.model ? `${displayModel(envOverrides.merger?.trim() || effective.model)} · ${envOverrides.mergerThinking?.trim() || effective.thinkingLevel}` : t("未设置模型")}
              </small>
            )}
          </section>
        );
      })}
      <button type="button" className="secondary scoped-models-button" disabled={busy} onClick={() => setScopedModelsOpen(true)}>{t("管理可见模型")}</button>
    </div>
  );
}
