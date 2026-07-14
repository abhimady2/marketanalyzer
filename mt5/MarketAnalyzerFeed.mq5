//+------------------------------------------------------------------+
//|                                          MarketAnalyzerFeed.mq5   |
//|   Pushes live price + recent candles (M15/H1/H4/D1) from MT5 to   |
//|   the Market Analyzer backend (Next.js /api/ingest) via           |
//|   WebRequest. Attach to ONE XAUUSD chart on your VPS.             |
//|                                                                    |
//|   SETUP (once): MetaTrader → Tools → Options → Expert Advisors →   |
//|   tick "Allow WebRequest for listed URL" and add your domain,      |
//|   e.g.  https://your-app.vercel.app                                |
//+------------------------------------------------------------------+
#property copyright "Market Analyzer"
#property version   "1.00"

input string InpServerUrl = "https://YOUR-APP.vercel.app/api/ingest"; // Ingest endpoint (whitelist this URL)
input string InpSecret    = "change-me-to-match-INGEST_SECRET";       // Must equal INGEST_SECRET on the server
input string InpSymbol    = "XAUUSD.sc"; // Vantage gold symbol ("" = use the chart symbol)
input int    InpTimerSec  = 30;        // Push interval (seconds)
input int    InpCandles   = 200;       // Candles per timeframe to send
input bool   InpSendM15   = true;
input bool   InpSendH1    = true;
input bool   InpSendH4    = true;
input bool   InpSendD1    = true;
input bool   InpSendNews  = true;      // Push MT5 economic calendar (High/Medium impact)
input int    InpNewsDays  = 7;         // Calendar days ahead to send

string gSymbol;
int    gDigits;

//+------------------------------------------------------------------+
int OnInit()
{
   gSymbol = (InpSymbol == "" ? _Symbol : InpSymbol);
   gDigits = (int)SymbolInfoInteger(gSymbol, SYMBOL_DIGITS);
   if(gDigits <= 0) gDigits = 2;

   int t = (InpTimerSec < 5 ? 5 : InpTimerSec);
   EventSetTimer(t);

   Print("MarketAnalyzerFeed started: ", gSymbol, " every ", t, "s → ", InpServerUrl);
   Print("If pushes fail with error 4014/5200/5203, whitelist the URL in "
         "Tools → Options → Expert Advisors → Allow WebRequest.");
   PushFeed();   // send one immediately so the site fills in without waiting
   return(INIT_SUCCEEDED);
}

void OnDeinit(const int reason) { EventKillTimer(); }
void OnTimer() { PushFeed(); }

//+------------------------------------------------------------------+
//| Build a JSON array of the last `count` candles, oldest→newest.   |
//+------------------------------------------------------------------+
string CandlesJson(ENUM_TIMEFRAMES tf, int count)
{
   MqlRates rates[];
   ArraySetAsSeries(rates, true);            // index 0 = most recent
   int got = CopyRates(gSymbol, tf, 0, count, rates);
   if(got <= 0) return("[]");

   string s = "[";
   for(int i = got - 1; i >= 0; i--)         // walk oldest→newest for the analyzer
   {
      if(i < got - 1) s += ",";
      long t_ms = (long)rates[i].time * 1000;
      s += "{\"t\":" + (string)t_ms
         + ",\"o\":" + DoubleToString(rates[i].open,  gDigits)
         + ",\"h\":" + DoubleToString(rates[i].high,  gDigits)
         + ",\"l\":" + DoubleToString(rates[i].low,   gDigits)
         + ",\"c\":" + DoubleToString(rates[i].close, gDigits)
         + ",\"v\":" + (string)((long)rates[i].tick_volume) + "}";
   }
   s += "]";
   return(s);
}

//+------------------------------------------------------------------+
//| Minimal JSON string escaping for event names.                    |
//+------------------------------------------------------------------+
string JsonEscape(string s)
{
   StringReplace(s, "\\", " ");
   StringReplace(s, "\"", "'");
   StringReplace(s, "\n", " ");
   StringReplace(s, "\r", " ");
   StringReplace(s, "\t", " ");
   return(s);
}

//+------------------------------------------------------------------+
//| MT5 economic calendar → JSON (High/Medium impact only).          |
//| Returns "[]" if the broker/terminal provides no calendar.        |
//+------------------------------------------------------------------+
string CalendarJson(int daysAhead, int daysBack)
{
   MqlCalendarValue values[];
   datetime from = TimeCurrent() - (datetime)daysBack  * 86400;
   datetime to   = TimeCurrent() + (datetime)daysAhead * 86400;
   int total = CalendarValueHistory(values, from, to, NULL, NULL);
   if(total <= 0) return("[]");

   string s = "[";
   bool first = true;
   for(int i = 0; i < total; i++)
   {
      MqlCalendarEvent ev;
      if(!CalendarEventById(values[i].event_id, ev)) continue;
      if(ev.importance == CALENDAR_IMPORTANCE_NONE || ev.importance == CALENDAR_IMPORTANCE_LOW) continue;

      MqlCalendarCountry cc;
      string cur = CalendarCountryById(ev.country_id, cc) ? cc.currency : "";
      string imp = (ev.importance == CALENDAR_IMPORTANCE_HIGH) ? "High" : "Medium";
      string fc  = values[i].HasForecastValue() ? DoubleToString(values[i].GetForecastValue(), 2) : "";
      string pv  = values[i].HasPreviousValue() ? DoubleToString(values[i].GetPreviousValue(), 2) : "";
      string ac  = values[i].HasActualValue()   ? DoubleToString(values[i].GetActualValue(),   2) : "";

      if(!first) s += ",";
      first = false;
      s += "{\"title\":\""    + JsonEscape(ev.name) + "\""
         + ",\"country\":\""  + cur + "\""
         + ",\"impact\":\""   + imp + "\""
         + ",\"date\":"       + (string)((long)values[i].time * 1000)
         + ",\"forecast\":\"" + fc + "\""
         + ",\"previous\":\"" + pv + "\""
         + ",\"actual\":\""   + ac + "\"}";
   }
   s += "]";
   return(s);
}

//+------------------------------------------------------------------+
//| Assemble the payload and POST it to the backend.                 |
//+------------------------------------------------------------------+
void PushFeed()
{
   double bid  = SymbolInfoDouble(gSymbol, SYMBOL_BID);
   double ask  = SymbolInfoDouble(gSymbol, SYMBOL_ASK);
   double last = SymbolInfoDouble(gSymbol, SYMBOL_LAST);
   if(last <= 0) last = bid;                 // forex symbols often report LAST = 0

   string tf = "";
   bool   first = true;
   if(InpSendM15) { tf += (first?"":",") + string("\"15m\":") + CandlesJson(PERIOD_M15, InpCandles); first = false; }
   if(InpSendH1)  { tf += (first?"":",") + string("\"1h\":")  + CandlesJson(PERIOD_H1,  InpCandles); first = false; }
   if(InpSendH4)  { tf += (first?"":",") + string("\"4h\":")  + CandlesJson(PERIOD_H4,  InpCandles); first = false; }
   if(InpSendD1)  { tf += (first?"":",") + string("\"1d\":")  + CandlesJson(PERIOD_D1,  InpCandles); first = false; }

   string news = InpSendNews ? CalendarJson(InpNewsDays, 1) : "[]";

   string body = "{\"secret\":\"" + InpSecret + "\""
      + ",\"symbol\":\"" + gSymbol + "\""
      + ",\"price\":{\"bid\":" + DoubleToString(bid, gDigits)
      + ",\"ask\":" + DoubleToString(ask, gDigits)
      + ",\"last\":" + DoubleToString(last, gDigits)
      + ",\"time\":" + (string)((long)TimeCurrent() * 1000) + "}"
      + ",\"candles\":{" + tf + "}"
      + ",\"news\":" + news + "}";

   char post[], result[];
   string resultHeaders;
   int len = StringToCharArray(body, post, 0, WHOLE_ARRAY, CP_UTF8);
   if(len > 0) ArrayResize(post, len - 1);   // drop the trailing '\0' StringToCharArray adds

   string headers = "Content-Type: application/json\r\nAuthorization: Bearer " + InpSecret + "\r\n";

   ResetLastError();
   int code = WebRequest("POST", InpServerUrl, headers, 10000, post, result, resultHeaders);
   if(code == -1)
   {
      int err = GetLastError();
      Print("WebRequest failed (error ", err, ")",
            (err==4014 || err==5200 || err==5203)
              ? " — whitelist the URL: Tools → Options → Expert Advisors → Allow WebRequest." : "");
      return;
   }
   if(code != 200)
      Print("Ingest returned HTTP ", code, ": ", CharArrayToString(result));
}
//+------------------------------------------------------------------+
