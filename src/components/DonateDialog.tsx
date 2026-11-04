interface Props {
  onClose: () => void;
}

export default function DonateDialog({ onClose }: Props) {
  return (
    <div className="update-backdrop" onPointerDown={onClose}>
      <div
        className="update-dialog donate-dialog"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <div className="update-title">赞赏作者</div>
        <div className="donate-copy">
          如果 EasyLog Serial 对你的调试工作有帮助，欢迎扫码请作者喝杯咖啡。
          赞赏完全自愿，不影响任何功能，也不代表商业服务承诺。
        </div>
        <div className="donate-qr-wrap">
          <img
            className="donate-qr"
            src="/donate-wechat-qr.png"
            alt="微信赞赏码"
            draggable={false}
          />
        </div>
        <div className="donate-tip">微信扫一扫 · 感谢支持</div>
        <div className="update-actions">
          <button type="button" className="update-primary" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
