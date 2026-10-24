// QQ 官方头像 CDN：https://thirdqq.qlogo.cn/qqapp/{appid}/{用户openid}/{规格}
// 规格常用 40/100/640，100 为最小规格；openid 须与 appid 同 bot 维度（open_id 机器人文隔离）。
// 未知 openid 不 404，返回官方默认占位图（已实测 2026-10-24）；群 openid 与 bot 自身取不到真头像（同为占位图）。
export const qqAvatar = (appid: string, openid: string, size: 40 | 100 | 640 = 100): string =>
  `https://thirdqq.qlogo.cn/qqapp/${appid}/${openid}/${size}`;
