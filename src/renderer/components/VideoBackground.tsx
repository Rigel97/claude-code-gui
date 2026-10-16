import { useEffect, useRef, useState } from 'react';
import { useStore } from '../store';

/**
 * 动态视频背景（可选，设置面板开关）
 * - 视频文件由用户在设置中选择，主进程经 bgmedia:// 自定义协议按 Range 流式提供
 *   （dev 的 http origin 与生产 file:// 都无法直接读本地视频，自定义协议统一两条路径）
 * - 视频之上叠压暗层保证正文可读；窗口隐藏时暂停播放省电
 * - 加载失败（文件被删/移动/编码不支持）静默隐藏，回落到原深色粒子背景
 */
export function VideoBackground() {
  const videoBg = useStore((s) => s.videoBg);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [failed, setFailed] = useState(false);

  const src =
    videoBg.enabled && videoBg.path
      ? `bgmedia://video/${encodeURIComponent(videoBg.path)}`
      : null;

  // 把当前路径登记进主进程白名单（启动恢复时重新登记；关闭时释放）
  useEffect(() => {
    const api = (window as any).api?.videoBg;
    if (!api) return;
    if (videoBg.enabled && videoBg.path) {
      void api.setPath(videoBg.path);
    } else {
      void api.clear();
    }
  }, [videoBg.enabled, videoBg.path]);

  // 切换视频源时重置失败态
  useEffect(() => {
    setFailed(false);
  }, [src]);

  // 窗口最小化/隐藏时暂停解码，恢复可见时续播
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !src) return;
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        video.play().catch(() => {});
      } else {
        video.pause();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [src]);

  if (!src || failed) return null;

  return (
    <>
      <video
        ref={videoRef}
        key={src}
        src={src}
        className="fixed inset-0 w-full h-full object-cover pointer-events-none select-none"
        style={{ zIndex: 0 }}
        autoPlay
        loop
        muted
        playsInline
        preload="auto"
        disablePictureInPicture
        onError={() => setFailed(true)}
        aria-hidden="true"
      />
      {/* 压暗层：保住深色主题下的正文可读性，上下更暗与原背景渐变衔接 */}
      <div
        className="fixed inset-0 pointer-events-none"
        style={{
          zIndex: 0,
          background:
            'linear-gradient(180deg, rgba(5, 7, 13, 0.78) 0%, rgba(5, 7, 13, 0.55) 50%, rgba(5, 7, 13, 0.78) 100%)',
        }}
      />
    </>
  );
}
