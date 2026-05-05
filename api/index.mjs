export default async function handler(req, res) {
  // 1. 设置跨域头
  res.setHeader("Access-Control-Allow-Credentials", true);
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version",
  );

  // Vercel 缓存策略
  res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=60");

  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  try {
    const fullCookie = process.env.BI_COOKIE;
    const TARGET_UID = "7813153";

    if (!fullCookie) {
      throw new Error("环境变量 BI_COOKIE 未配置");
    }

    // 2. 准备 API URL
    // 接口 A: 动态历史
    const VIDEO_LIMIT = 10;
    const MAX_DYNAMIC_PAGES = 3;
    const buildDynamicUrl = (offsetDynamicId) =>
      `https://api.vc.bilibili.com/dynamic_svr/v1/dynamic_svr/space_history?host_uid=${TARGET_UID}&offset_dynamic_id=${encodeURIComponent(offsetDynamicId)}&need_top=${offsetDynamicId === "0" ? 1 : 0}&platform=web`;
    const dynamicUrl = buildDynamicUrl("0");

    // 接口 B: 用户名片 (用于获取头像、粉丝数、关注数)
    const cardUrl = `https://api.bilibili.com/x/web-interface/card?mid=${TARGET_UID}&photo=true`;

    // 接口 C: 直播状态专用接口 (新增！这个接口查直播状态最准)
    // 注意：这个接口返回的是一个对象，key 是 uid
    const liveStatusUrl = `https://api.live.bilibili.com/room/v1/Room/get_status_info_by_uids?uids[]=${TARGET_UID}`;

    // 公用 Headers
    const commonHeaders = {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      Referer: `https://space.bilibili.com/${TARGET_UID}`,
      Cookie: fullCookie,
    };

    // 3. 并发发起请求 (Promise.all 加入 liveStatusUrl)
    const [dynamicRes, cardRes, liveRes] = await Promise.all([
      fetch(dynamicUrl, { headers: commonHeaders }),
      fetch(cardUrl, { headers: commonHeaders }),
      fetch(liveStatusUrl, { headers: commonHeaders }),
    ]);

    // 4. 处理响应
    if (!dynamicRes.ok || !cardRes.ok || !liveRes.ok) {
      throw new Error(`B站服务器连接失败`);
    }

    const dynamicData = await dynamicRes.json();
    const cardData = await cardRes.json();
    const liveDataRaw = await liveRes.json();

    // 检查业务错误码
    if (dynamicData.code !== 0)
      throw new Error(`动态API错误: ${dynamicData.message}`);
    if (cardData.code !== 0)
      throw new Error(`用户卡片API错误: ${cardData.message}`);
    // 直播接口很少报错，即使没开播 code 也是 0

    // 5. 解析动态数据
    const videos = [];
    const seenBvids = new Set();

    const appendVideosFromCards = (cards) => {
      for (const item of cards) {
        if (videos.length >= VIDEO_LIMIT) {
          break;
        }

        if (item.desc?.type === 8) {
          // 8 = 投稿视频
          try {
            const cardDetail = JSON.parse(item.card);
            const bvid = item.desc.bvid || cardDetail.bvid;

            if (!bvid || seenBvids.has(bvid)) {
              continue;
            }

            seenBvids.add(bvid);
            videos.push({
              title: cardDetail.title,
              desc: cardDetail.desc,
              pic: cardDetail.pic,
              bvid,
              url: `https://www.bilibili.com/video/${bvid}`,
              created: item.desc.timestamp,
              length: cardDetail.duration,
              play: cardDetail.stat?.view,
              comment: cardDetail.stat?.reply,
              date: new Date(item.desc.timestamp * 1000).toLocaleDateString(
                "zh-CN",
              ),
            });
          } catch (e) {
            console.error("解析单条动态失败", e);
          }
        }
      }
    };

    appendVideosFromCards(dynamicData.data?.cards || []);

    let offsetDynamicId = dynamicData.data?.next_offset
      ? String(dynamicData.data.next_offset)
      : "";
    let hasMore =
      dynamicData.data?.has_more !== 0 && dynamicData.data?.has_more !== false;
    let fetchedDynamicPages = 1;

    while (
      videos.length < VIDEO_LIMIT &&
      fetchedDynamicPages < MAX_DYNAMIC_PAGES &&
      hasMore &&
      offsetDynamicId
    ) {
      try {
        const nextDynamicRes = await fetch(buildDynamicUrl(offsetDynamicId), {
          headers: commonHeaders,
        });

        if (!nextDynamicRes.ok) {
          break;
        }

        const nextDynamicData = await nextDynamicRes.json();

        if (nextDynamicData.code !== 0) {
          break;
        }

        appendVideosFromCards(nextDynamicData.data?.cards || []);
        fetchedDynamicPages += 1;

        const nextOffset = nextDynamicData.data?.next_offset;
        hasMore =
          nextDynamicData.data?.has_more !== 0 &&
          nextDynamicData.data?.has_more !== false;

        if (!hasMore || !nextOffset || String(nextOffset) === offsetDynamicId) {
          break;
        }

        offsetDynamicId = String(nextOffset);
      } catch (e) {
        console.error("动态翻页失败", e);
        break;
      }
    }

    // 6. 解析用户信息
    const cardInfo = cardData.data?.card || {};

    // 解析直播数据 (从专用接口获取)
    // 结构是: data: { "uid": { ...info } }
    const targetLiveInfo = liveDataRaw.data?.[TARGET_UID] || {};

    const userInfo = {
      name: cardInfo.name,
      face: cardInfo.face,
      fans: cardInfo.fans,
      attention: cardInfo.attention,
      is_live: targetLiveInfo.live_status === 1,
      live_title: targetLiveInfo.title || "",
      live_url: targetLiveInfo.room_id
        ? `https://live.bilibili.com/${targetLiveInfo.room_id}`
        : "",
      live_cover:
        targetLiveInfo.cover_from_user || targetLiveInfo.keyframe || "",
      // 直播分区：area_v2_* 是新版字段，兼容旧版 area_name / parent_name
      live_area: targetLiveInfo.area_v2_name || targetLiveInfo.area_name || "",
      live_area_parent:
        targetLiveInfo.area_v2_parent_name || targetLiveInfo.parent_name || "",
    };

    // 7. 返回合并后的数据
    res.status(200).json({
      success: true,
      uid: TARGET_UID,
      user: userInfo,
      video_count: videos.length,
      videos: videos,
    });
  } catch (error) {
    console.error("API Error:", error);
    res.status(500).json({
      success: false,
      error: error.message || "服务器内部错误",
    });
  }
}
