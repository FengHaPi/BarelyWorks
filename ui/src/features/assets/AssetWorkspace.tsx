import { useEffect, useState } from "react";
import type { ArtifactDetail, ArtifactSummary } from "../../../../src/shared/api-contracts/agent-first";
import { api } from "../../api";
import type { Asset, AssetReferenceRole } from "../../types";
import { validateReferenceUpload } from "../../upload";
import { ArtifactEditor } from "../artifacts/ArtifactEditor";
import { allowedReferenceRoles, referenceRoleDescription, supportsImageReferences } from "../../../../src/shared/asset-reference-role";
import type { CumulativeVerificationLedger } from "../../../../src/shared/cumulative-verification";

function fileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("读取参考图失败"));
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.readAsDataURL(file);
  });
}

export function AssetWorkspace(props: {
  projectId: string;
  label: string;
  versions: ArtifactSummary[];
  selectedId: string | null;
  detail: ArtifactDetail | null;
  loading: boolean;
  onSelectVersion: (artifactId: string) => void;
  onChanged: () => Promise<void> | void;
  onOpenIssues?: () => void;
  onStartStructuredRepair?: () => Promise<void>;
  verificationLedger?: CumulativeVerificationLedger | null;
}) {
  const [tab, setTab] = useState<"definition" | "references">("references");
  const [assets, setAssets] = useState<Asset[]>([]);
  const [loadingAssets, setLoadingAssets] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [authorized, setAuthorized] = useState(false);
  const [roleByAsset, setRoleByAsset] = useState<Record<string, AssetReferenceRole>>({});
  const [busy, setBusy] = useState<string | null>(null);

  async function reloadAssets() {
    setLoadingAssets(true);
    setError(null);
    try { setAssets((await api.listAssets(props.projectId)).assets); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "资产记录载入失败"); }
    finally { setLoadingAssets(false); }
  }

  useEffect(() => { void reloadAssets(); }, [props.projectId]);
  useEffect(() => {
    if (props.detail?.artifact.metadata.origin === "continuity-targeted-repair") setTab("definition");
  }, [props.detail?.artifact.id]);

  const visualAssets = assets.filter((asset) => supportsImageReferences(asset.type));
  const selectedRole = (asset: Asset): AssetReferenceRole => roleByAsset[asset.id] ?? allowedReferenceRoles(asset.type)[0] ?? "主参考";

  async function upload(asset: Asset, file: File, replaceIndex?: number) {
    setBusy(`${asset.id}:${replaceIndex ?? "new"}`);
    setError(null);
    setNotice(null);
    try {
      if (!authorized) throw new Error("请先确认你有权使用这张图片");
      validateReferenceUpload(file);
      const dataBase64 = await fileAsBase64(file);
      if (replaceIndex === undefined) {
        const role = selectedRole(asset);
        await api.uploadAssetReference(props.projectId, asset.id, {
          fileName: file.name,
          mimeType: file.type,
          dataBase64,
          role,
          authorizationConfirmed: true,
        }, "agent-first");
        setNotice(`${asset.name} 已新增一张${role}；原有图片未被覆盖。`);
      } else {
        await api.replaceAssetReference(props.projectId, asset.id, replaceIndex, {
          fileName: file.name,
          mimeType: file.type,
          dataBase64,
          authorizationConfirmed: true,
        }, "agent-first");
        setNotice(`${asset.name} 的第 ${replaceIndex + 1} 张参考图已替换；旧文件已归档。`);
      }
      await reloadAssets();
      await props.onChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "参考图保存失败");
    } finally { setBusy(null); }
  }

  async function remove(asset: Asset, index: number) {
    if (!window.confirm(`删除 ${asset.name} 的第 ${index + 1} 张参考图？文件会归档，不会永久抹除。`)) return;
    setBusy(`${asset.id}:${index}`);
    setError(null);
    setNotice(null);
    try {
      const result = await api.deleteAssetReference(props.projectId, asset.id, index, "agent-first");
      setNotice(`参考图已从当前资产移除，历史文件已归档为 ${result.archivedFileName}。`);
      await reloadAssets();
      await props.onChanged();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "参考图删除失败"); }
    finally { setBusy(null); }
  }

  return <div className="af-asset-workspace">
    <nav className="af-subtabs" aria-label="资产定义视图">
      <button className={tab === "references" ? "is-active" : ""} onClick={() => setTab("references")}>参考图片 <b>{visualAssets.reduce((sum, asset) => sum + asset.localFiles.length, 0)}</b></button>
      <button className={tab === "definition" ? "is-active" : ""} onClick={() => setTab("definition")}>定义与版本</button>
    </nav>
    {tab === "definition" ? <ArtifactEditor {...props} /> : <section className="af-content-panel af-resource-workspace">
      <header><div><span className="af-kicker">资产注册表</span><h2>参考图片</h2></div><span className="af-chip">上传 / 替换 / 归档删除</span></header>
      <div className="af-guidance"><strong>图片角色会进入后续提示词</strong><p>上传后，角色会写入 H3 的参考素材表和主体约束。主参考负责整体身份；正面、侧面、背面、表情、服装只覆盖各自维度。没有参考图时使用文字资产定义，不会伪装成已提供图片。</p></div>
      <div className="af-asset-upload-controls">
        <label><input type="checkbox" checked={authorized} onChange={(event) => setAuthorized(event.target.checked)} /> 我确认拥有这些图片的使用权</label>
        <span>音频资产不显示图片入口；每个视觉资产单独选择用途。</span>
      </div>
      {notice && <div className="af-notice">{notice}</div>}
      {error && <div className="af-global-error">{error}</div>}
      {loadingAssets ? <div className="af-loading-inline">正在载入资产注册表…</div> : <div className="af-asset-list">
        {visualAssets.map((asset) => {
          const roles = allowedReferenceRoles(asset.type);
          const role = selectedRole(asset);
          return <article className="af-asset-card" key={asset.id}>
          <header><div><strong>{asset.name}</strong><small>{asset.id} · {asset.type}</small></div><span className={asset.productionReady ? "ready" : "warning"}>{asset.productionReady ? "可制作" : "待补充"}</span></header>
          <p>{asset.designSummary || asset.identity || "尚无设计摘要"}</p>
          <div className="af-reference-role-control">
            <label>下一张图片的用途<select value={role} onChange={(event) => setRoleByAsset((current) => ({ ...current, [asset.id]: event.target.value as AssetReferenceRole }))}>{roles.map((item) => <option key={item}>{item}</option>)}</select></label>
            <p><strong>{role}</strong>：{referenceRoleDescription(role)}</p>
          </div>
          <div className="af-reference-grid">
            {asset.localFiles.map((_filePath, index) => <figure key={`${asset.id}:${index}`}>
              <img src={api.assetReferenceUrl(props.projectId, asset.id, index)} alt={`${asset.name} ${asset.fileRoles[index] ?? "参考图"}`} />
              <figcaption>{asset.fileRoles[index] ?? `参考图 ${index + 1}`}</figcaption>
              <div>
                <label className={busy ? "disabled" : ""}>替换<input disabled={Boolean(busy)} type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  event.currentTarget.value = "";
                  if (file) void upload(asset, file, index);
                }} /></label>
                <button className="danger" disabled={Boolean(busy)} onClick={() => void remove(asset, index)}>移除</button>
              </div>
            </figure>)}
            <label className={`af-reference-add ${busy ? "disabled" : ""}`}>
              <span>＋</span><strong>{busy === `${asset.id}:new` ? "上传中…" : "新增图片"}</strong>
              <input disabled={Boolean(busy)} type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                event.currentTarget.value = "";
                if (file) void upload(asset, file);
              }} />
            </label>
          </div>
        </article>})}
        {!visualAssets.length && <div className="af-empty"><strong>当前没有可上传图片的视觉资产</strong><p>音频资产不接受图片参考；请先在“定义与版本”创建人物、场景、道具、服装、风格或参考类资产。</p></div>}
      </div>}
    </section>}
  </div>;
}
