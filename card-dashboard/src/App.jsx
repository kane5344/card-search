import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY
)

/* 데이터가 예상과 다르면 여기만 고치면 됨 */
const CFG = {
  TYPE_BASE: '기본', // 기존회원 (기본할인)
  TYPE_PROMO: '프로모션', // 신규회원 (프로모션)
  TYPE_INSTALL: '할부이용', // 가정: 기존회원(기본) 칸에 합쳐 표시
  INSTALL_AS_BASE: true,
  TEL_CATS: ['통신', '통신-할부형'],
  RENTAL_CATS: ['렌탈'],
  SELF_KEYWORD: '아정당', // 자사카드 하이라이트 판별 키워드(carrier/card_name)
}

// 콤마·"원"·문자 섞인 값에서 숫자만 추출. 못 뽑으면 null
const num = (v) => {
  if (v == null) return null
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  const digits = String(v).replace(/[^0-9.-]/g, '')
  if (digits === '' || digits === '-' || digits === '.') return null
  const n = Number(digits)
  return Number.isFinite(n) ? n : null
}
const won = (v) => {
  const n = num(v)
  return n == null ? '' : n.toLocaleString('ko-KR')
}
const tier = (v) => {
  const n = num(v)
  return n == null ? '' : `${n.toLocaleString('ko-KR')}만원`
}
// 공백 무시 그룹 키 (표기 미묘하게 달라 쪼개지는 중복 합침)
const gkey = (r) =>
  [r.carrier, r.issuer, r.card_name].map((s) => String(s ?? '').replace(/\s+/g, '')).join('||')
// issuer 비었을 때만 카드명으로 보정. LOCA/로카→롯데, IBK→기업, 그 외 공란 유지
const fillIssuer = (issuer, cardName) => {
  if (issuer != null && String(issuer).trim() !== '') return issuer
  const n = String(cardName || '')
  if (/LOCA|로카/i.test(n)) return '롯데'
  if (/IBK/i.test(n)) return '기업'
  return ''
}
// 자사(아정당) 행 판별 — carrier 또는 card_name에 키워드 포함
const isSelf = (r) =>
  [r.carrier, r.card_name].some((s) => String(s ?? '').includes(CFG.SELF_KEYWORD))

/* long → wide 피벗 (25개월후/혜택기간 제외) */
function pivot(rows) {
  const groups = new Map()
  for (const r of rows) {
    const key = gkey(r)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(r)
  }

  const out = []
  for (const g of groups.values()) {
    const base = g[0]
    const tiers = g.map((r) => num(r.spend_tier)).filter((v) => v != null)
    const minT = tiers.length ? Math.min(...tiers) : null
    const maxT = tiers.length ? Math.max(...tiers) : null

    const pick = (t, type) => {
      const hit = g.find((r) => num(r.spend_tier) === t && r.type === type)
      if (hit) return num(hit.discount)
      if (type === CFG.TYPE_BASE && CFG.INSTALL_AS_BASE) {
        const inst = g.find((r) => num(r.spend_tier) === t && r.type === CFG.TYPE_INSTALL)
        if (inst) return num(inst.discount)
      }
      return null
    }

    const hasTiers = tiers.length > 0
    let discMin, discMax
    if (hasTiers) {
      // 프로모션 있으면 프로모션, 없으면 기본 (합산 아님)
      discMin = pick(minT, CFG.TYPE_PROMO) ?? pick(minT, CFG.TYPE_BASE)
      discMax = pick(maxT, CFG.TYPE_PROMO) ?? pick(maxT, CFG.TYPE_BASE)
    } else {
      // 실적구간 없는 카드(SKT 범위형 등): 전체 할인값의 최소/최대
      const ds = g.map((r) => num(r.discount)).filter((v) => v != null)
      discMin = ds.length ? Math.min(...ds) : null
      discMax = ds.length ? Math.max(...ds) : null
    }

    out.push({
      carrier: base.carrier,
      issuer: fillIssuer(base.issuer, base.card_name),
      card_name: base.card_name,
      fee: g.map((r) => r.fee).find((v) => v != null && v !== '') ?? '', // 원문 그대로
      tierMin: minT,
      tierMax: maxT,
      discMin,
      discMax,
      _self: isSelf(base),
    })
  }
  // 수집된 값이 하나도 없는 행은 대시보드에서 제외
  return out.filter((r) => [r.discMin, r.discMax].some((v) => v != null))
}

function withRowspan(rows) {
  // 자사(아정당) 먼저 → 그다음 통신사/카드사順. 자사가 표 상단에 모임.
  const sorted = [...rows].sort(
    (a, b) =>
      (b._self ? 1 : 0) - (a._self ? 1 : 0) ||
      a.carrier.localeCompare(b.carrier, 'ko') ||
      a.issuer.localeCompare(b.issuer, 'ko') ||
      a.card_name.localeCompare(b.card_name, 'ko')
  )
  const counts = {}
  sorted.forEach((r) => (counts[r.carrier] = (counts[r.carrier] || 0) + 1))
  let prev = null
  return sorted.map((r) => {
    const first = r.carrier !== prev
    prev = r.carrier
    return { ...r, _carrierFirst: first, _carrierSpan: counts[r.carrier] }
  })
}

function Cell({ v, money, isTier }) {
  const text = isTier ? tier(v) : money ? won(v) : v
  return (
    <td className="border border-slate-200 px-2 py-1 text-right tabular-nums">{text || ''}</td>
  )
}

function CompareTable({ rows, firstColLabel, selfMin }) {
  const data = withRowspan(rows)
  if (!data.length)
    return <div className="text-slate-400 text-sm py-8 text-center">표시할 카드가 없습니다.</div>

  // 가맹점(carrier)별 "최저구간 할인 최댓값" 계산 → 아정당 기준(selfMin) 미달 판정
  //  · 아정당 자신은 제외
  //  · discMin(=최저구간 시점 할인)이 있는 카드만 집계. 전부 없으면 판정 스킵(null)
  //  · 목적: 아정당 카드 판매용. "이 가맹점은 최저구간 할인이 우리보다 약함" 내부 신호.
  const carrierWeak = {}
  if (selfMin != null) {
    const byCarrier = {}
    for (const r of data) {
      if (r._self) continue
      const d = r.discMin
      if (d == null) continue
      byCarrier[r.carrier] = Math.max(byCarrier[r.carrier] ?? -Infinity, d)
    }
    for (const [c, maxDisc] of Object.entries(byCarrier)) {
      carrierWeak[c] = maxDisc < selfMin // 그 가맹점 최고 최저구간할인 < 아정당 → 열위
    }
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white shadow-sm">
      <style>{`
        @keyframes ajdSoftPulse {
          0%, 100% { background-color: rgba(74,222,128,0.18); }
          50%      { background-color: rgba(74,222,128,0.45); }
        }
        .ajd-weak-cell { animation: ajdSoftPulse 2.2s ease-in-out infinite; }
      `}</style>
      <table className="w-full border-collapse text-[13px]">
        <thead className="sticky top-0 z-10">
          <tr className="bg-slate-700 text-white">
            <th className="border border-slate-600 px-2 py-2 whitespace-nowrap">{firstColLabel}</th>
            <th className="border border-slate-600 px-2 py-2 whitespace-nowrap">카드사</th>
            <th className="border border-slate-600 px-2 py-2 whitespace-nowrap text-left">카드명</th>
            <th className="border border-slate-600 px-2 py-2 whitespace-nowrap">연회비</th>
            <th className="border border-slate-600 px-2 py-2 whitespace-nowrap">전월실적(최소)</th>
            <th className="border border-slate-600 px-2 py-2 whitespace-nowrap bg-emerald-700/80">청구할인<br/>(최소·프로모션포함)</th>
            <th className="border border-slate-600 px-2 py-2 whitespace-nowrap">전월실적(최대)</th>
            <th className="border border-slate-600 px-2 py-2 whitespace-nowrap bg-sky-800/80">청구할인<br/>(최대·프로모션포함)</th>
          </tr>
        </thead>
        <tbody>
          {data.map((r, i) => {
            const weak = !r._self && carrierWeak[r.carrier]
            return (
            <tr
              key={i}
              className={
                r._self
                  ? 'bg-amber-100/70 font-medium hover:bg-amber-200/60'
                  : 'even:bg-slate-50/60 hover:bg-amber-50'
              }
            >
              {r._carrierFirst && (
                <td
                  rowSpan={r._carrierSpan}
                  className={
                    'border border-slate-200 px-2 py-1 text-center font-semibold align-middle ' +
                    (r._self ? 'bg-amber-200/60' : (weak ? 'ajd-weak-cell' : 'bg-slate-100'))
                  }
                  title={weak ? '최저구간 할인이 아정당보다 낮음 (아정당 카드 유리)' : undefined}
                >
                  {r.carrier}
                  {weak && <span className="block text-[10px] font-normal text-emerald-800 mt-0.5">아정당 유리</span>}
                </td>
              )}
              <td className="border border-slate-200 px-2 py-1 text-center whitespace-nowrap">{r.issuer}</td>
              <td className="border border-slate-200 px-2 py-1 text-left whitespace-nowrap">{r.card_name}</td>
              <td className="border border-slate-200 px-2 py-1 text-left text-[11px] text-slate-600 leading-tight min-w-[140px]">{r.fee || ''}</td>
              <Cell v={r.tierMin} isTier />
              <Cell v={r.discMin} money />
              <Cell v={r.tierMax} isTier />
              <Cell v={r.discMax} money />
            </tr>
          )})}
        </tbody>
      </table>
    </div>
  )
}

export default function App() {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState(null)
  const [tab, setTab] = useState('통신')
  const [latestDate, setLatestDate] = useState(null)

  useEffect(() => {
    ;(async () => {
      try {
        const { data, error } = await supabase.from('card_benefit2').select('*').limit(5000)
        if (error) throw error
        const dates = data.map((r) => r.date).filter(Boolean).sort()
        const newest = dates[dates.length - 1] || null
        setLatestDate(newest)
        setRows(newest ? data.filter((r) => r.date === newest) : data)
      } catch (e) {
        setErr(e.message || String(e))
      } finally {
        setLoading(false)
      }
    })()
  }, [])

  const telRows = useMemo(
    () => pivot(rows.filter((r) => CFG.TEL_CATS.includes(r.category))),
    [rows]
  )
  const rentalRows = useMemo(
    () => pivot(rows.filter((r) => CFG.RENTAL_CATS.includes(r.category))),
    [rows]
  )

  // 아정당 최저구간 기준값 T (탭별). 아정당 카드들 중 discMin(최저구간 할인) 최댓값.
  //  · 우리 18,000 vs 하나 15,000 → 18,000. 이 값 미만인 가맹점을 '아정당 유리'로 표시.
  //  · 필터로 아정당이 걸러져도 판정이 유지되도록 '필터 전' 원본에서 계산해 넘김.
  const selfMinOf = (arr) => {
    const ds = arr.filter((r) => r._self).map((r) => r.discMin).filter((v) => v != null)
    return ds.length ? Math.max(...ds) : null
  }
  const telSelfMin = useMemo(() => selfMinOf(telRows), [telRows])
  const rentalSelfMin = useMemo(() => selfMinOf(rentalRows), [rentalRows])

  // 현재 탭의 카드사(issuer) 목록 + 선택된 필터
  const [issuerFilter, setIssuerFilter] = useState('전체')
  const activeRows = tab === '통신' ? telRows : rentalRows
  const issuerOptions = useMemo(() => {
    const set = new Set(
      activeRows.map((r) => String(r.issuer || '').trim()).filter((v) => v !== '')
    )
    return ['전체', ...Array.from(set).sort((a, b) => a.localeCompare(b, 'ko'))]
  }, [activeRows])
  // 탭 바뀌면 필터 초기화 (통신 카드사 ≠ 렌탈 카드사라 잔존값이 빈 표 유발)
  useEffect(() => setIssuerFilter('전체'), [tab])
  const filteredRows = useMemo(
    () =>
      issuerFilter === '전체'
        ? activeRows
        : activeRows.filter((r) => String(r.issuer || '').trim() === issuerFilter),
    [activeRows, issuerFilter]
  )

  return (
    <div className="min-h-screen p-4 md:p-8 max-w-[1400px] mx-auto">
      <header className="mb-4">
        <h1 className="text-xl font-bold text-slate-800">통신·렌탈 할인카드 비교표</h1>
        {latestDate && (
          <p className="text-xs text-slate-500 mt-1">기준일: {latestDate}</p>
        )}
      </header>

      <div className="flex items-center gap-2 mb-3">
        {['통신', '렌탈'].map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-1.5 rounded-md text-sm font-medium transition ${
              tab === t ? 'bg-slate-700 text-white' : 'bg-white text-slate-600 border border-slate-200'
            }`}
          >
            {t} ({t === '통신' ? telRows.length : rentalRows.length})
          </button>
        ))}
        <div className="ml-auto flex items-center gap-2">
          <label className="text-xs text-slate-500">카드사</label>
          <select
            value={issuerFilter}
            onChange={(e) => setIssuerFilter(e.target.value)}
            className="px-3 py-1.5 rounded-md text-sm border border-slate-200 bg-white text-slate-700 focus:outline-none focus:ring-2 focus:ring-slate-300"
          >
            {issuerOptions.map((o) => (
              <option key={o} value={o}>
                {o === '전체' ? '전체 카드사' : o}
              </option>
            ))}
          </select>
        </div>
      </div>

      {loading && <div className="text-slate-400 py-12 text-center">불러오는 중…</div>}
      {err && (
        <div className="text-rose-600 bg-rose-50 border border-rose-200 rounded p-3 text-sm">
          데이터 로드 실패: {err}
          <div className="text-rose-400 text-xs mt-1">
            VITE_SUPABASE_URL / ANON_KEY 환경변수와 card_benefit2 RLS read 정책을 확인하세요.
          </div>
        </div>
      )}

      {!loading && !err && (
        <CompareTable
          rows={filteredRows}
          firstColLabel={tab === '통신' ? '통신사' : '가맹점'}
          selfMin={tab === '통신' ? telSelfMin : rentalSelfMin}
        />
      )}
    </div>
  )
}
