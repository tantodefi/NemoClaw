// proton-tool: CLI wrapper around go-proton-api for Proton Mail/Calendar
package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/mail"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/ProtonMail/gluon/rfc822"
	"github.com/ProtonMail/go-proton-api"
	"github.com/ProtonMail/gopenpgp/v2/crypto"
)

// sessionFile is the default path for cached auth tokens.
// Avoids SRP logins on every invocation, preventing Proton 429 rate limits.
var sessionFile = "/sandbox/.proton-session.json"

type savedSession struct {
	UID          string `json:"uid"`
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	SavedAt      int64  `json:"saved_at"`
}

func init() {
	if v := os.Getenv("PROTON_SESSION_FILE"); v != "" {
		sessionFile = v
	}
}

func saveSession(auth proton.Auth) {
	s := savedSession{
		UID:          auth.UID,
		AccessToken:  auth.AccessToken,
		RefreshToken: auth.RefreshToken,
		SavedAt:      time.Now().Unix(),
	}
	data, err := json.Marshal(s)
	if err != nil {
		return
	}
	dir := filepath.Dir(sessionFile)
	os.MkdirAll(dir, 0700)
	os.WriteFile(sessionFile, data, 0600)
}

func loadSession() (*savedSession, error) {
	data, err := os.ReadFile(sessionFile)
	if err != nil {
		return nil, err
	}
	var s savedSession
	if err := json.Unmarshal(data, &s); err != nil {
		return nil, err
	}
	if s.UID == "" || s.RefreshToken == "" {
		return nil, fmt.Errorf("incomplete session")
	}
	// Discard sessions older than 24 hours — force a fresh SRP login.
	if time.Now().Unix()-s.SavedAt > 86400 {
		return nil, fmt.Errorf("session expired")
	}
	return &s, nil
}

func clearSession() {
	os.Remove(sessionFile)
}

func usage() {
	fmt.Fprintf(os.Stderr, "proton-tool - Proton Mail and Calendar CLI\n\n")
	fmt.Fprintf(os.Stderr, "Usage:\n")
	fmt.Fprintf(os.Stderr, "  proton-tool logout           Clear cached session tokens\n")
	fmt.Fprintf(os.Stderr, "  proton-tool whoami           Show authenticated user info\n")
	fmt.Fprintf(os.Stderr, "  proton-tool calendars        List all calendars\n")
	fmt.Fprintf(os.Stderr, "  proton-tool events           List events from default calendar\n")
	fmt.Fprintf(os.Stderr, "    --calendar-id=ID           Calendar ID (uses first if omitted)\n")
	fmt.Fprintf(os.Stderr, "    --days=N                   Look-ahead days (default: 7)\n")
	fmt.Fprintf(os.Stderr, "    --past=N                   Also show N past days (default: 0)\n")
	fmt.Fprintf(os.Stderr, "  proton-tool mail             List inbox messages\n")
	fmt.Fprintf(os.Stderr, "    --limit=N                  Number of messages (default: 10)\n")
	fmt.Fprintf(os.Stderr, "  proton-tool sent             List sent messages\n")
	fmt.Fprintf(os.Stderr, "    --limit=N                  Number of messages (default: 10)\n")
	fmt.Fprintf(os.Stderr, "    --days=N                   Only show messages from last N days (default: all)\n")
	fmt.Fprintf(os.Stderr, "  proton-tool count-mail       Show message counts per label\n")
	fmt.Fprintf(os.Stderr, "  proton-tool read-mail        Read a specific message body\n")
	fmt.Fprintf(os.Stderr, "    --id=MSGID                 Message ID (required)\n")
	fmt.Fprintf(os.Stderr, "  proton-tool mark-read        Mark messages as read\n")
	fmt.Fprintf(os.Stderr, "    --id=MSGID1,MSGID2,...     Message IDs (required, comma-separated)\n")
	fmt.Fprintf(os.Stderr, "  proton-tool send-mail        Send a new email\n")
	fmt.Fprintf(os.Stderr, "    --to=ADDR                  Recipient address (required, comma-separated for multiple)\n")
	fmt.Fprintf(os.Stderr, "    --cc=ADDR                  CC addresses (optional, comma-separated)\n")
	fmt.Fprintf(os.Stderr, "    --subject=TEXT             Subject line (required)\n")
	fmt.Fprintf(os.Stderr, "    --body=TEXT                Body text (reads stdin if omitted)\n")
	fmt.Fprintf(os.Stderr, "    --html                     Send as HTML (default: plain text)\n")
	fmt.Fprintf(os.Stderr, "  proton-tool reply-mail       Reply to an existing message\n")
	fmt.Fprintf(os.Stderr, "    --id=MSGID                 Message ID to reply to (required)\n")
	fmt.Fprintf(os.Stderr, "    --body=TEXT                Reply body (reads stdin if omitted)\n")
	fmt.Fprintf(os.Stderr, "    --all                      Reply all (includes original To/CC)\n")
	fmt.Fprintf(os.Stderr, "  proton-tool trash-mail       Move messages to trash\n")
	fmt.Fprintf(os.Stderr, "    --id=MSGID1,MSGID2,...     Message IDs (required, comma-separated)\n")
	fmt.Fprintf(os.Stderr, "  proton-tool labels           List custom labels and folders\n")
	fmt.Fprintf(os.Stderr, "\nEnvironment:\n")
	fmt.Fprintf(os.Stderr, "  PROTON_USERNAME      Proton account email\n")
	fmt.Fprintf(os.Stderr, "  PROTON_PASSWORD      Proton account password\n")
	fmt.Fprintf(os.Stderr, "  PROTON_SESSION_FILE  Path to session cache (default: /sandbox/.proton-session.json)\n")
	os.Exit(1)
}

func fatal(msg string, err error) {
	fmt.Fprintf(os.Stderr, "Error: %s: %v\n", msg, err)
	os.Exit(1)
}

func login(ctx context.Context) (*proton.Manager, *proton.Client) {
	return loginWithScope(ctx, false)
}

// loginFull performs a full SRP login, bypassing session cache.
// Use for commands that need key decryption (events, read-mail, send-mail,
// reply-mail) since refreshed tokens have insufficient scope for /core/v4/keys/salts.
func loginFull(ctx context.Context) (*proton.Manager, *proton.Client) {
	return loginWithScope(ctx, true)
}

func loginWithScope(ctx context.Context, needFullScope bool) (*proton.Manager, *proton.Client) {
	username := os.Getenv("PROTON_USERNAME")
	password := os.Getenv("PROTON_PASSWORD")
	if username == "" || password == "" {
		fmt.Fprintln(os.Stderr, "Error: PROTON_USERNAME and PROTON_PASSWORD must be set")
		os.Exit(1)
	}

	m := proton.New(
		proton.WithHostURL("https://mail-api.proton.me"),
		proton.WithAppVersion("web-mail@5.0.36"),
	)

	// Try to restore session from cached tokens (uses /auth/v4/refresh,
	// which is NOT subject to the same rate limit as SRP /auth/v4).
	// Skip for commands needing full scope (key decryption) — refresh
	// tokens return limited scope that can't access /core/v4/keys/salts.
	if !needFullScope {
		if sess, err := loadSession(); err == nil {
			c, auth, err := m.NewClientWithRefresh(ctx, sess.UID, sess.RefreshToken)
			if err == nil {
				saveSession(auth)
				return m, c
			}
			fmt.Fprintf(os.Stderr, "Session refresh failed, falling back to SRP login: %v\n", err)
			clearSession()
		}
	}

	// Full SRP login — this is rate-limited by Proton to ~10/hour.
	c, auth, err := m.NewClientWithLogin(ctx, username, []byte(password))
	if err != nil {
		fatal("login failed", err)
	}

	if auth.TwoFA.Enabled&proton.HasTOTP != 0 {
		fmt.Fprintln(os.Stderr, "Error: 2FA (TOTP) is enabled. This tool does not support 2FA yet.")
		c.Close()
		m.Close()
		os.Exit(1)
	}

	// Cache the session for subsequent invocations.
	saveSession(auth)

	return m, c
}

func getArg(args []string, prefix string, defaultVal string) string {
	for _, a := range args {
		if len(a) > len(prefix) && a[:len(prefix)] == prefix {
			return a[len(prefix):]
		}
	}
	return defaultVal
}

func cmdWhoami(ctx context.Context) {
	m, c := login(ctx)
	defer c.Close()
	defer m.Close()

	user, err := c.GetUser(ctx)
	if err != nil {
		fatal("get user", err)
	}

	fmt.Printf("Name:         %s\n", user.Name)
	fmt.Printf("DisplayName:  %s\n", user.DisplayName)
	fmt.Printf("Email:        %s\n", user.Email)
	fmt.Printf("UsedSpace:    %d bytes\n", user.UsedSpace)
	fmt.Printf("MaxSpace:     %d bytes\n", user.MaxSpace)
}

func cmdCalendars(ctx context.Context) {
	m, c := login(ctx)
	defer c.Close()
	defer m.Close()

	calendars, err := c.GetCalendars(ctx)
	if err != nil {
		fatal("get calendars", err)
	}

	if len(calendars) == 0 {
		fmt.Println("No calendars found.")
		return
	}

	for i, cal := range calendars {
		calType := "normal"
		if cal.Type == proton.CalendarTypeSubscribed {
			calType = "subscribed"
		}
		fmt.Printf("[%d] ID: %s\n", i+1, cal.ID)
		fmt.Printf("    Name:        %s\n", cal.Name)
		fmt.Printf("    Description: %s\n", cal.Description)
		fmt.Printf("    Color:       %s\n", cal.Color)
		fmt.Printf("    Type:        %s\n", calType)
		fmt.Printf("    Display:     %v\n", bool(cal.Display))

		members, err := c.GetCalendarMembers(ctx, cal.ID)
		if err == nil && len(members) > 0 {
			fmt.Printf("    Members:\n")
			for _, mem := range members {
				fmt.Printf("      - %s (permissions: %d, color: %s)\n", mem.Email, mem.Permissions, mem.Color)
			}
		}
		fmt.Println()
	}
}

// calendarEventPageSize is the max page size accepted by the Proton Calendar
// API. The go-proton-api library defaults to 150 (maxPageSize) which the
// Calendar endpoint rejects with "Invalid page size parameter" (code 2021).
const calendarEventPageSize = 100

func getAllCalendarEvents(ctx context.Context, c *proton.Client, calendarID string, filter url.Values) ([]proton.CalendarEvent, error) {
	var all []proton.CalendarEvent
	page := 0
	for {
		events, err := c.GetCalendarEvents(ctx, calendarID, page, calendarEventPageSize, filter)
		if err != nil {
			return nil, err
		}
		all = append(all, events...)
		if len(events) < calendarEventPageSize {
			break
		}
		page++
	}
	return all, nil
}

func cmdEvents(ctx context.Context, args []string) {
	password := []byte(os.Getenv("PROTON_PASSWORD"))
	m, c := loginFull(ctx)
	defer c.Close()
	defer m.Close()

	calendarID := getArg(args, "--calendar-id=", "")
	daysStr := getArg(args, "--days=", "7")
	days, _ := strconv.Atoi(daysStr)
	if days <= 0 {
		days = 7
	}
	pastStr := getArg(args, "--past=", "0")
	past, _ := strconv.Atoi(pastStr)
	if past < 0 {
		past = 0
	}

	if calendarID == "" {
		calendars, err := c.GetCalendars(ctx)
		if err != nil {
			fatal("get calendars", err)
		}
		if len(calendars) == 0 {
			fmt.Println("No calendars found.")
			return
		}
		calendarID = calendars[0].ID
		fmt.Printf("Using calendar: %s (ID: %s)\n\n", calendars[0].Name, calendarID)
	}

	now := time.Now().UTC()
	start := now.Add(-time.Duration(past) * 24 * time.Hour)
	end := now.Add(time.Duration(days) * 24 * time.Hour)

	filter := url.Values{}
	filter.Set("Start", strconv.FormatInt(start.Unix(), 10))
	filter.Set("End", strconv.FormatInt(end.Unix(), 10))

	events, err := getAllCalendarEvents(ctx, c, calendarID, filter)
	if err != nil {
		fatal("get events", err)
	}

	if len(events) == 0 {
		fmt.Printf("No events in the requested window (%d past, %d ahead days).\n", past, days)
		return
	}

	// Unlock keys for event decryption.
	_, _, addrKR := unlockKeys(ctx, c, password)
	calKR := unlockCalendarKeys(ctx, c, calendarID, addrKR)

	fmt.Printf("Found %d events:\n\n", len(events))
	for i, ev := range events {
		evStart := time.Unix(ev.StartTime, 0).UTC()
		evEnd := time.Unix(ev.EndTime, 0).UTC()

		// Decrypt SharedEvents (SUMMARY, DESCRIPTION, LOCATION, RRULE)
		summary, description, location, rrule := decryptSharedEvent(ev, calKR)

		// Decrypt CalendarEvents (ORGANIZER, full ATTENDEE list)
		organizer, attendeeEmails := decryptCalendarEventParts(ev, calKR)

		fmt.Printf("[%d] Event ID: %s\n", i+1, ev.ID)
		if summary != "" {
			fmt.Printf("    Summary:   %s\n", summary)
		}
		if organizer != "" {
			fmt.Printf("    Organizer: %s\n", organizer)
		}
		if location != "" {
			fmt.Printf("    Location:  %s\n", location)
		}
		if description != "" {
			fmt.Printf("    Desc:      %s\n", description)
		}
		if rrule != "" {
			fmt.Printf("    Recurs:    %s\n", rrule)
		}
		fmt.Printf("    Start:     %s\n", evStart.Format(time.RFC3339))
		fmt.Printf("    End:       %s\n", evEnd.Format(time.RFC3339))
		if ev.StartTimezone != "" {
			fmt.Printf("    Timezone:  %s\n", ev.StartTimezone)
		}
		fmt.Printf("    Full Day:  %v\n", bool(ev.FullDay))
		fmt.Printf("    Author:    %s\n", ev.Author)

		// Show attendees: emails from CalendarEvents, statuses from Attendees array
		if len(attendeeEmails) > 0 {
			fmt.Printf("    Attendees: %s\n", strings.Join(attendeeEmails, ", "))
		} else if len(ev.Attendees) > 0 {
			fmt.Printf("    Attendees: %d\n", len(ev.Attendees))
		}

		// Show attendee status breakdown from the API (Pending/Yes/No/Maybe)
		if len(ev.Attendees) > 0 {
			yes, no, maybe, pending := 0, 0, 0, 0
			for _, a := range ev.Attendees {
				switch a.Status {
				case proton.CalendarAttendeeStatusYes:
					yes++
				case proton.CalendarAttendeeStatusNo:
					no++
				case proton.CalendarAttendeeStatusMaybe:
					maybe++
				default:
					pending++
				}
			}
			parts := []string{}
			if yes > 0 {
				parts = append(parts, fmt.Sprintf("%d accepted", yes))
			}
			if no > 0 {
				parts = append(parts, fmt.Sprintf("%d declined", no))
			}
			if maybe > 0 {
				parts = append(parts, fmt.Sprintf("%d maybe", maybe))
			}
			if pending > 0 {
				parts = append(parts, fmt.Sprintf("%d pending", pending))
			}
			if len(parts) > 0 {
				fmt.Printf("    RSVP:      %s\n", strings.Join(parts, ", "))
			}
		}
		fmt.Println()
	}
}

// unlockCalendarKeys decrypts the calendar passphrase and uses it to unlock
// the calendar's private keys, returning a keyring suitable for decrypting
// event data.
func unlockCalendarKeys(ctx context.Context, c *proton.Client, calendarID string, addrKR *crypto.KeyRing) *crypto.KeyRing {
	members, err := c.GetCalendarMembers(ctx, calendarID)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Warning: could not get calendar members: %v\n", err)
		return nil
	}

	passphrase, err := c.GetCalendarPassphrase(ctx, calendarID)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Warning: could not get calendar passphrase: %v\n", err)
		return nil
	}

	// Try each member until we find one we can decrypt (our own membership).
	var rawPassphrase []byte
	for _, mem := range members {
		rawPassphrase, err = passphrase.Decrypt(mem.ID, addrKR)
		if err == nil {
			break
		}
	}
	if rawPassphrase == nil {
		fmt.Fprintf(os.Stderr, "Warning: could not decrypt calendar passphrase (not a member?)\n")
		return nil
	}

	calKeys, err := c.GetCalendarKeys(ctx, calendarID)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Warning: could not get calendar keys: %v\n", err)
		return nil
	}

	calKR, err := calKeys.Unlock(rawPassphrase)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Warning: could not unlock calendar keys: %v\n", err)
		return nil
	}

	return calKR
}

// decryptSharedEvent decrypts the SharedEvents parts of a CalendarEvent and
// extracts SUMMARY, DESCRIPTION, LOCATION, and RRULE from the VEVENT data.
// SharedEvents use SharedKeyPacket.
func decryptSharedEvent(ev proton.CalendarEvent, calKR *crypto.KeyRing) (summary, description, location, rrule string) {
	if calKR == nil || len(ev.SharedEvents) == 0 {
		return
	}

	var kp []byte
	if ev.SharedKeyPacket != "" {
		var err error
		kp, err = base64.StdEncoding.DecodeString(ev.SharedKeyPacket)
		if err != nil {
			return
		}
	}

	for _, part := range ev.SharedEvents {
		decrypted := decryptEventPart(part, calKR, kp)
		if decrypted == "" {
			continue
		}
		if v := icalProp(decrypted, "SUMMARY"); v != "" && summary == "" {
			summary = v
		}
		if v := icalProp(decrypted, "DESCRIPTION"); v != "" && description == "" {
			description = v
		}
		if v := icalProp(decrypted, "LOCATION"); v != "" && location == "" {
			location = v
		}
		if v := icalProp(decrypted, "RRULE"); v != "" && rrule == "" {
			rrule = v
		}
	}
	return
}

// decryptCalendarEventParts decrypts CalendarEvents parts (which use
// CalendarKeyPacket, distinct from SharedKeyPacket) and extracts ORGANIZER
// and full ATTENDEE email addresses.
func decryptCalendarEventParts(ev proton.CalendarEvent, calKR *crypto.KeyRing) (organizer string, attendees []string) {
	if calKR == nil || len(ev.CalendarEvents) == 0 {
		return
	}

	var kp []byte
	if ev.CalendarKeyPacket != "" {
		var err error
		kp, err = base64.StdEncoding.DecodeString(ev.CalendarKeyPacket)
		if err != nil {
			return
		}
	}

	for _, part := range ev.CalendarEvents {
		decrypted := decryptEventPart(part, calKR, kp)
		if decrypted == "" {
			continue
		}
		if v := icalProp(decrypted, "ORGANIZER"); v != "" && organizer == "" {
			organizer = stripMailto(v)
		}
		for _, email := range icalAllProps(decrypted, "ATTENDEE") {
			attendees = append(attendees, stripMailto(email))
		}
	}
	return
}

func stripMailto(s string) string {
	if strings.HasPrefix(strings.ToLower(s), "mailto:") {
		return s[7:]
	}
	return s
}

// decryptEventPart decrypts a single CalendarEventPart and returns the
// plaintext. Returns "" on any error.
func decryptEventPart(part proton.CalendarEventPart, calKR *crypto.KeyRing, kp []byte) string {
	if part.Type&proton.CalendarEventTypeEncrypted != 0 {
		var enc *crypto.PGPMessage

		if kp != nil {
			raw, err := base64.StdEncoding.DecodeString(part.Data)
			if err != nil {
				return ""
			}
			enc = crypto.NewPGPSplitMessage(kp, raw).GetPGPMessage()
		} else {
			var err error
			enc, err = crypto.NewPGPMessageFromArmored(part.Data)
			if err != nil {
				return ""
			}
		}

		dec, err := calKR.Decrypt(enc, nil, crypto.GetUnixTime())
		if err != nil {
			return ""
		}
		return dec.GetString()
	}

	// Clear-text part.
	return part.Data
}

// icalProp extracts a property value from an iCalendar text blob.
// Handles simple "KEY:value" lines and folded lines (continuation with
// leading space/tab). Also handles parameters like "KEY;PARAM=X:value".
func icalProp(ical, key string) string {
	vals := icalAllProps(ical, key)
	if len(vals) > 0 {
		return vals[0]
	}
	return ""
}

// icalAllProps extracts all values of a property from an iCalendar text blob.
// Used for multi-value properties like ATTENDEE.
func icalAllProps(ical, key string) []string {
	// Unfold: iCalendar continuation lines start with a space or tab.
	ical = strings.ReplaceAll(ical, "\r\n ", "")
	ical = strings.ReplaceAll(ical, "\r\n\t", "")
	ical = strings.ReplaceAll(ical, "\n ", "")
	ical = strings.ReplaceAll(ical, "\n\t", "")

	var values []string
	for _, line := range strings.Split(ical, "\n") {
		line = strings.TrimRight(line, "\r")
		if strings.HasPrefix(line, key+":") {
			values = append(values, line[len(key)+1:])
		} else if strings.HasPrefix(line, key+";") {
			idx := strings.Index(line, ":")
			if idx >= 0 {
				values = append(values, line[idx+1:])
			}
		}
	}
	return values
}

func cmdMail(ctx context.Context, args []string) {
	m, c := login(ctx)
	defer c.Close()
	defer m.Close()

	limitStr := getArg(args, "--limit=", "10")
	limit, _ := strconv.Atoi(limitStr)
	if limit <= 0 {
		limit = 10
	}

	filter := proton.MessageFilter{
		LabelID: proton.InboxLabel,
	}

	messages, err := c.GetMessageMetadata(ctx, filter)
	if err != nil {
		fatal("get messages", err)
	}

	if len(messages) == 0 {
		fmt.Println("No messages in inbox.")
		return
	}

	if len(messages) > limit {
		messages = messages[:limit]
	}

	fmt.Printf("Inbox (%d messages shown):\n\n", len(messages))
	for i, msg := range messages {
		t := time.Unix(msg.Time, 0).UTC()
		fmt.Printf("[%d] %s\n", i+1, msg.Subject)
		if msg.Sender != nil {
			fmt.Printf("    From:    %s <%s>\n", msg.Sender.Name, msg.Sender.Address)
		}
		if len(msg.CCList) > 0 {
			ccAddrs := make([]string, 0, len(msg.CCList))
			for _, a := range msg.CCList {
				ccAddrs = append(ccAddrs, a.Address)
			}
			fmt.Printf("    CC:      %s\n", strings.Join(ccAddrs, ", "))
		}
		fmt.Printf("    Date:    %s\n", t.Format(time.RFC3339))
		fmt.Printf("    ID:      %s\n", msg.ID)

		// State indicators
		flags := []string{}
		if bool(msg.Unread) {
			flags = append(flags, "UNREAD")
		}
		if bool(msg.IsReplied) {
			flags = append(flags, "replied")
		}
		if bool(msg.IsForwarded) {
			flags = append(flags, "forwarded")
		}
		if msg.NumAttachments > 0 {
			flags = append(flags, fmt.Sprintf("%d attachment(s)", msg.NumAttachments))
		}
		if msg.Flags.Has(proton.MessageFlagPhishingAuto) || msg.Flags.Has(proton.MessageFlagPhishingManual) {
			flags = append(flags, "⚠ PHISHING")
		} else if msg.Flags.Has(proton.MessageFlagSpamAuto) || msg.Flags.Has(proton.MessageFlagSpamManual) {
			flags = append(flags, "⚠ SPAM")
		}
		if len(flags) > 0 {
			fmt.Printf("    Flags:   %s\n", strings.Join(flags, ", "))
		}
		fmt.Println()
	}
}

func cmdSent(ctx context.Context, args []string) {
	m, c := login(ctx)
	defer c.Close()
	defer m.Close()

	limitStr := getArg(args, "--limit=", "10")
	limit, _ := strconv.Atoi(limitStr)
	if limit <= 0 {
		limit = 10
	}

	daysStr := getArg(args, "--days=", "0")
	days, _ := strconv.Atoi(daysStr)

	filter := proton.MessageFilter{
		LabelID: proton.AllSentLabel,
	}

	messages, err := c.GetMessageMetadata(ctx, filter)
	if err != nil {
		fatal("get sent messages", err)
	}

	if len(messages) == 0 {
		fmt.Println("No sent messages.")
		return
	}

	// Filter by recency if --days was given
	if days > 0 {
		cutoff := time.Now().UTC().Add(-time.Duration(days) * 24 * time.Hour)
		var filtered []proton.MessageMetadata
		for _, msg := range messages {
			if time.Unix(msg.Time, 0).UTC().After(cutoff) {
				filtered = append(filtered, msg)
			}
		}
		messages = filtered
	}

	if len(messages) > limit {
		messages = messages[:limit]
	}

	fmt.Printf("Sent (%d messages shown):\n\n", len(messages))
	for i, msg := range messages {
		t := time.Unix(msg.Time, 0).UTC()
		fmt.Printf("[%d] %s\n", i+1, msg.Subject)
		if len(msg.ToList) > 0 {
			var toAddrs []string
			for _, addr := range msg.ToList {
				toAddrs = append(toAddrs, fmt.Sprintf("%s <%s>", addr.Name, addr.Address))
			}
			fmt.Printf("    To:      %s\n", strings.Join(toAddrs, ", "))
		}
		fmt.Printf("    Date:    %s\n", t.Format(time.RFC3339))
		fmt.Printf("    ID:      %s\n", msg.ID)
		fmt.Println()
	}
}

func cmdCountMail(ctx context.Context) {
	m, c := login(ctx)
	defer c.Close()
	defer m.Close()

	counts, err := c.GetGroupedMessageCount(ctx)
	if err != nil {
		fatal("count messages", err)
	}

	// Map well-known label IDs to readable names
	labelNames := map[string]string{
		proton.InboxLabel:        "Inbox",
		proton.AllDraftsLabel:    "All Drafts",
		proton.AllSentLabel:      "All Sent",
		proton.TrashLabel:        "Trash",
		proton.SpamLabel:         "Spam",
		proton.AllMailLabel:      "All Mail",
		proton.ArchiveLabel:      "Archive",
		proton.SentLabel:         "Sent",
		proton.DraftsLabel:       "Drafts",
		proton.StarredLabel:      "Starred",
		proton.AllScheduledLabel: "Scheduled",
	}

	fmt.Println("Message counts by label:")
	for _, count := range counts {
		name, ok := labelNames[count.LabelID]
		if !ok {
			name = "Label:" + count.LabelID
		}
		if count.Unread > 0 {
			fmt.Printf("  %-16s total=%-6d  unread=%d\n", name, count.Total, count.Unread)
		} else {
			fmt.Printf("  %-16s total=%d\n", name, count.Total)
		}
	}
}

// unlockKeys returns the address keyring for the primary send address.
func unlockKeys(ctx context.Context, c *proton.Client, password []byte) (
	user proton.User,
	addr proton.Address,
	addrKR *crypto.KeyRing,
) {
	var err error

	user, err = c.GetUser(ctx)
	if err != nil {
		fatal("get user", err)
	}

	salts, err := c.GetSalts(ctx)
	if err != nil {
		fatal("get salts", err)
	}

	saltedKeyPass, err := salts.SaltForKey(password, user.Keys.Primary().ID)
	if err != nil {
		fatal("salt key passphrase", err)
	}

	addresses, err := c.GetAddresses(ctx)
	if err != nil {
		fatal("get addresses", err)
	}

	for _, a := range addresses {
		if bool(a.Send) {
			addr = a
			break
		}
	}
	if addr.ID == "" {
		fmt.Fprintln(os.Stderr, "Error: no send-capable address found")
		os.Exit(1)
	}

	_, addrKRs, err := proton.Unlock(user, addresses, saltedKeyPass, nil)
	if err != nil {
		fatal("unlock keys", err)
	}

	addrKR = addrKRs[addr.ID]
	if addrKR == nil {
		fmt.Fprintln(os.Stderr, "Error: could not unlock address keyring")
		os.Exit(1)
	}

	return user, addr, addrKR
}

func parseAddressList(s string) []*mail.Address {
	var addrs []*mail.Address
	for _, part := range strings.Split(s, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		addrs = append(addrs, &mail.Address{Address: part})
	}
	return addrs
}

func cmdReadMail(ctx context.Context, args []string) {
	msgID := getArg(args, "--id=", "")
	if msgID == "" {
		fmt.Fprintln(os.Stderr, "Error: --id=MSGID is required")
		os.Exit(1)
	}

	password := []byte(os.Getenv("PROTON_PASSWORD"))
	m, c := loginFull(ctx)
	defer c.Close()
	defer m.Close()

	_, _, addrKR := unlockKeys(ctx, c, password)

	msg, err := c.GetMessage(ctx, msgID)
	if err != nil {
		fatal("get message", err)
	}

	body, err := msg.Decrypt(addrKR)
	if err != nil {
		fatal("decrypt message", err)
	}

	// Auto-mark as read
	if bool(msg.Unread) {
		if err := c.MarkMessagesRead(ctx, msgID); err != nil {
			fmt.Fprintf(os.Stderr, "Warning: failed to mark as read: %v\n", err)
		}
	}

	fmt.Printf("Subject: %s\n", msg.Subject)
	if msg.Sender != nil {
		fmt.Printf("From:    %s <%s>\n", msg.Sender.Name, msg.Sender.Address)
	}
	if len(msg.ToList) > 0 {
		toAddrs := make([]string, 0, len(msg.ToList))
		for _, a := range msg.ToList {
			toAddrs = append(toAddrs, a.Address)
		}
		fmt.Printf("To:      %s\n", strings.Join(toAddrs, ", "))
	}
	if len(msg.CCList) > 0 {
		ccAddrs := make([]string, 0, len(msg.CCList))
		for _, a := range msg.CCList {
			ccAddrs = append(ccAddrs, a.Address)
		}
		fmt.Printf("CC:      %s\n", strings.Join(ccAddrs, ", "))
	}
	fmt.Printf("Date:    %s\n", time.Unix(msg.Time, 0).UTC().Format(time.RFC3339))
	if msg.NumAttachments > 0 {
		fmt.Printf("Attachments: %d\n", msg.NumAttachments)
	}
	fmt.Printf("Type:    %s\n", msg.MIMEType)
	fmt.Printf("ID:      %s\n", msg.ID)
	fmt.Println()
	fmt.Println(string(body))
}

func cmdMarkRead(ctx context.Context, args []string) {
	idsStr := getArg(args, "--id=", "")
	if idsStr == "" {
		fmt.Fprintln(os.Stderr, "Error: --id=MSGID1,MSGID2,... is required")
		os.Exit(1)
	}

	m, c := login(ctx)
	defer c.Close()
	defer m.Close()

	ids := strings.Split(idsStr, ",")
	for i := range ids {
		ids[i] = strings.TrimSpace(ids[i])
	}

	var failed []string
	for _, id := range ids {
		if id == "" {
			continue
		}
		if err := c.MarkMessagesRead(ctx, id); err != nil {
			fmt.Fprintf(os.Stderr, "Warning: failed to mark %s as read: %v\n", id, err)
			failed = append(failed, id)
		}
	}

	marked := len(ids) - len(failed)
	fmt.Printf("Marked %d/%d messages as read.\n", marked, len(ids))
	if len(failed) > 0 {
		fmt.Printf("Failed: %s\n", strings.Join(failed, ", "))
	}
}

// buildAndSend constructs and sends a draft. Shared by send-mail and reply-mail.
func buildAndSend(
	ctx context.Context,
	c *proton.Client,
	addrKR *crypto.KeyRing,
	addr proton.Address,
	req proton.CreateDraftReq,
	bodyText string,
	mimeType rfc822.MIMEType,
) {
	draft, err := c.CreateDraft(ctx, addrKR, req)
	if err != nil {
		fatal("create draft", err)
	}
	fmt.Printf("Draft created: %s\n", draft.ID)

	allRecipients := append(req.Message.ToList, req.Message.CCList...)
	internalPrefs := make(map[string]proton.SendPreferences)
	clearPrefs := make(map[string]proton.SendPreferences)

	for _, rcpt := range allRecipients {
		email := rcpt.Address
		pubKeys, recipientType, err := c.GetPublicKeys(ctx, email)
		if err != nil {
			fatal("get public keys for "+email, err)
		}

		if recipientType == proton.RecipientTypeInternal && len(pubKeys) > 0 {
			rcptKR, err := pubKeys.GetKeyRing()
			if err != nil {
				fatal("build keyring for "+email, err)
			}
			internalPrefs[email] = proton.SendPreferences{
				Encrypt:          true,
				PubKey:           rcptKR,
				SignatureType:    proton.DetachedSignature,
				EncryptionScheme: proton.InternalScheme,
				MIMEType:         mimeType,
			}
		} else {
			clearPrefs[email] = proton.SendPreferences{
				Encrypt:          false,
				SignatureType:    proton.NoSignature,
				EncryptionScheme: proton.ClearScheme,
				MIMEType:         mimeType,
			}
		}
	}

	var sendReq proton.SendDraftReq
	if len(internalPrefs) > 0 {
		if err := sendReq.AddTextPackage(addrKR, bodyText, mimeType, internalPrefs, nil); err != nil {
			fatal("add internal package", err)
		}
	}
	if len(clearPrefs) > 0 {
		if err := sendReq.AddTextPackage(addrKR, bodyText, mimeType, clearPrefs, nil); err != nil {
			fatal("add clear package", err)
		}
	}

	sent, err := c.SendDraft(ctx, draft.ID, sendReq)
	if err != nil {
		fatal("send draft", err)
	}

	fmt.Printf("Email sent successfully!\n")
	fmt.Printf("  Message ID: %s\n", sent.ID)
	fmt.Printf("  Subject:    %s\n", sent.Subject)
}

func cmdSendMail(ctx context.Context, args []string) {
	toStr := getArg(args, "--to=", "")
	ccStr := getArg(args, "--cc=", "")
	subject := getArg(args, "--subject=", "")
	bodyText := getArg(args, "--body=", "")

	if toStr == "" {
		fmt.Fprintln(os.Stderr, "Error: --to=ADDR is required")
		os.Exit(1)
	}
	if subject == "" {
		fmt.Fprintln(os.Stderr, "Error: --subject=TEXT is required")
		os.Exit(1)
	}

	if bodyText == "" {
		data, err := os.ReadFile("/dev/stdin")
		if err != nil {
			fatal("read stdin", err)
		}
		bodyText = string(data)
	}

	mimeType := rfc822.TextPlain
	for _, a := range args {
		if a == "--html" {
			mimeType = rfc822.TextHTML
		}
	}

	toList := parseAddressList(toStr)
	ccList := parseAddressList(ccStr)

	password := []byte(os.Getenv("PROTON_PASSWORD"))
	m, c := loginFull(ctx)
	defer c.Close()
	defer m.Close()

	_, addr, addrKR := unlockKeys(ctx, c, password)

	req := proton.CreateDraftReq{
		Message: proton.DraftTemplate{
			Subject:  subject,
			Sender:   &mail.Address{Address: addr.Email},
			ToList:   toList,
			CCList:   ccList,
			Body:     bodyText,
			MIMEType: mimeType,
		},
	}
	fmt.Printf("  To:         %s\n", toStr)
	if ccStr != "" {
		fmt.Printf("  CC:         %s\n", ccStr)
	}
	buildAndSend(ctx, c, addrKR, addr, req, bodyText, mimeType)
}

func cmdReplyMail(ctx context.Context, args []string) {
	msgID := getArg(args, "--id=", "")
	if msgID == "" {
		fmt.Fprintln(os.Stderr, "Error: --id=MSGID is required")
		os.Exit(1)
	}
	bodyText := getArg(args, "--body=", "")

	replyAll := false
	for _, a := range args {
		if a == "--all" {
			replyAll = true
		}
	}

	if bodyText == "" {
		data, err := os.ReadFile("/dev/stdin")
		if err != nil {
			fatal("read stdin", err)
		}
		bodyText = string(data)
	}

	password := []byte(os.Getenv("PROTON_PASSWORD"))
	m, c := loginFull(ctx)
	defer c.Close()
	defer m.Close()

	_, addr, addrKR := unlockKeys(ctx, c, password)

	// Read the original message for threading and recipient info.
	msg, err := c.GetMessage(ctx, msgID)
	if err != nil {
		fatal("get message", err)
	}

	// Construct reply subject
	subject := msg.Subject
	if !strings.HasPrefix(strings.ToLower(subject), "re:") {
		subject = "Re: " + subject
	}

	// Reply goes to the original sender.
	toList := []*mail.Address{}
	if msg.Sender != nil {
		toList = append(toList, msg.Sender)
	}

	// For reply-all: also CC the original To list minus our own address.
	ccList := []*mail.Address{}
	action := proton.ReplyAction
	if replyAll {
		action = proton.ReplyAllAction
		for _, r := range msg.ToList {
			if !strings.EqualFold(r.Address, addr.Email) {
				ccList = append(ccList, r)
			}
		}
		ccList = append(ccList, msg.CCList...)
	}

	req := proton.CreateDraftReq{
		Message: proton.DraftTemplate{
			Subject:  subject,
			Sender:   &mail.Address{Address: addr.Email},
			ToList:   toList,
			CCList:   ccList,
			Body:     bodyText,
			MIMEType: rfc822.TextPlain,
		},
		ParentID: msgID,
		Action:   action,
	}

	fmt.Printf("Replying to: %s\n", msg.Subject)
	if msg.Sender != nil {
		fmt.Printf("  To:    %s\n", msg.Sender.Address)
	}
	buildAndSend(ctx, c, addrKR, addr, req, bodyText, rfc822.TextPlain)
}

func cmdTrashMail(ctx context.Context, args []string) {
	idsStr := getArg(args, "--id=", "")
	if idsStr == "" {
		fmt.Fprintln(os.Stderr, "Error: --id=MSGID1,MSGID2,... is required")
		os.Exit(1)
	}

	m, c := login(ctx)
	defer c.Close()
	defer m.Close()

	ids := strings.Split(idsStr, ",")
	for i := range ids {
		ids[i] = strings.TrimSpace(ids[i])
	}
	// Remove empty strings
	filtered := ids[:0]
	for _, id := range ids {
		if id != "" {
			filtered = append(filtered, id)
		}
	}
	ids = filtered

	if err := c.LabelMessages(ctx, ids, proton.TrashLabel); err != nil {
		fatal("move to trash", err)
	}

	fmt.Printf("Moved %d message(s) to trash.\n", len(ids))
}

func cmdLabels(ctx context.Context) {
	m, c := login(ctx)
	defer c.Close()
	defer m.Close()

	labels, err := c.GetLabels(ctx, proton.LabelTypeLabel, proton.LabelTypeFolder)
	if err != nil {
		fatal("get labels", err)
	}

	if len(labels) == 0 {
		fmt.Println("No custom labels or folders.")
		return
	}

	fmt.Printf("Custom labels and folders (%d):\n\n", len(labels))
	for _, l := range labels {
		typeName := "label"
		if l.Type == proton.LabelTypeFolder {
			typeName = "folder"
		}
		path := strings.Join(l.Path, "/")
		fmt.Printf("  [%s] %s  (ID: %s)\n", typeName, path, l.ID)
	}
}

func main() {
	if len(os.Args) < 2 {
		usage()
	}

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	cmd := os.Args[1]
	args := os.Args[2:]

	switch cmd {
	case "logout":
		clearSession()
		fmt.Println("Session cleared.")
	case "whoami":
		cmdWhoami(ctx)
	case "calendars":
		cmdCalendars(ctx)
	case "events":
		cmdEvents(ctx, args)
	case "mail":
		cmdMail(ctx, args)
	case "sent":
		cmdSent(ctx, args)
	case "count-mail":
		cmdCountMail(ctx)
	case "read-mail":
		cmdReadMail(ctx, args)
	case "mark-read":
		cmdMarkRead(ctx, args)
	case "send-mail":
		cmdSendMail(ctx, args)
	case "reply-mail":
		cmdReplyMail(ctx, args)
	case "trash-mail":
		cmdTrashMail(ctx, args)
	case "labels":
		cmdLabels(ctx)
	case "--help", "-h", "help":
		usage()
	default:
		fmt.Fprintf(os.Stderr, "Unknown command: %s\n\n", cmd)
		usage()
	}
}
