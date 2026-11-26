import React from "react";
import { Copy, Download, ExternalLink, FolderDown, Maximize2 } from "lucide-react";
import { t } from "../../i18n";
import { isMacosTauriDesktop } from "../../services/apiBase";
import { ContextMenu, type ContextMenuAnchor } from "./context-menu";
import {
  canSaveImageAs,
  copyImageToClipboard,
  downloadImage,
  openImageInNewWindow,
  saveImageAs,
  type ImageActionTarget,
} from "../../services/imageActions";

interface ImageContextMenuProps {
  anchor: ContextMenuAnchor;
  target: ImageActionTarget;
  onPreview?: () => void;
  onClose: () => void;
}

export function ImageContextMenu({
  anchor,
  target,
  onPreview,
  onClose,
}: ImageContextMenuProps) {
  const isMacosDesktop = isMacosTauriDesktop();
  const showSaveAs = canSaveImageAs();

  return (
    <ContextMenu anchor={anchor} label={t("图片操作")} onClose={onClose}>
      {onPreview && (
        <button
          type="button"
          role="menuitem"
          className="context-menu-item"
          onClick={() => onPreview()}
        >
          <Maximize2 size={14} />
          <span>{t("查看大图")}</span>
        </button>
      )}
      <button
        type="button"
        role="menuitem"
        className="context-menu-item"
        onClick={() => {
          void openImageInNewWindow(target).catch((err) =>
            console.warn("Open image in new window failed:", err),
          );
        }}
      >
        <ExternalLink size={14} />
        <span>{isMacosDesktop ? t("在预览中打开") : t("在新窗口中打开")}</span>
      </button>
      <button
        type="button"
        role="menuitem"
        className="context-menu-item"
        onClick={() => {
          void downloadImage(target).catch((err) =>
            console.warn("Download image failed:", err),
          );
        }}
      >
        <Download size={14} />
        <span>{t("下载图片")}</span>
      </button>
      {showSaveAs && (
        <button
          type="button"
          role="menuitem"
          className="context-menu-item"
          onClick={() => {
            void saveImageAs(target).catch((err) =>
              console.warn("Save image as failed:", err),
            );
          }}
        >
          <FolderDown size={14} />
          <span>{t("存储图片为…")}</span>
        </button>
      )}
      <button
        type="button"
        role="menuitem"
        className="context-menu-item"
        onClick={() => {
          void copyImageToClipboard(target);
        }}
      >
        <Copy size={14} />
        <span>{t("拷贝图片")}</span>
      </button>
    </ContextMenu>
  );
}
