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
	"sort"
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
	fmt.Fprintf(os.Stderr, "  proton-tool mail             List inbox messages (newest first)\n")
	fmt.Fprintf(os.Stderr, "    --limit=N                  Number of messages to show (default: 50)\n")
	fmt.Fprintf(os.Stderr, "    --unread                   Only show unread messages\n")
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
	fmt.Fprintf(os.Stderr, "    --body=TEXT                Reply body (required; stdin blocked by Landlock)\n")
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
	if sess, err := loadSession(); err == nil {
		c, auth, err := m.NewClientWithRefresh(ctx, sess.UID, sess.RefreshToken)
		if err == nil {
			saveSession(auth)
			return m, c
		}
		fmt.Fprintf(os.Stderr, "Session refresh failed, falling back to SRP login: %v\n", err)
		clearSession()
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

func hasFlag(args []string, flag string) bool {
	for _, a := range args {
		if a == flag {
			return true
		}
	}
	return false
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
	m, c := login(ctx)
	defer c.Close()
	defer m.Close()

	calendarID := getArg(args, "--calendar-id=", "")
	daysStr := getArg(args, "--days=", "7")
	days, _ := strconv.Atoi(daysStr)
	if days <= 0 {
		days = 7
	}
	pastStr := getArg(args, "--past=", "0")
	pastDays, _ := strconv.Atoi(pastStr)

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
	start := now.Add(-time.Duration(pastDays) * 24 * time.Hour)
	end := now.Add(time.Duration(days) * 24 * time.Hour)

	filter := url.Values{}
	filter.Set("Start", strconv.FormatInt(start.Unix(), 10))
	filter.Set("End", strconv.FormatInt(end.Unix(), 10))

	events, err := getAllCalendarEvents(ctx, c, calendarID, filter)
	if err != nil {
		fatal("get events", err)
	}

	if len(events) == 0 {
		fmt.Printf("No events in the next %d days.\n", days)
		return
	}

	// Unlock keys for event decryption.
	_, _, addrKR := unlockKeys(ctx, c, password)
	calKR := unlockCalendarKeys(ctx, c, calendarID, addrKR)

	fmt.Printf("Found %d events:\n\n", len(events))
	for i, ev := range events {
		start := time.Unix(ev.StartTime, 0).UTC()
		evEnd := time.Unix(ev.EndTime, 0).UTC()

		// Decrypt shared event data (contains SUMMARY, DESCRIPTION, LOCATION).
		summary, description, location := decryptSharedEvent(ev, calKR)

		fmt.Printf("[%d] Event ID: %s\n", i+1, ev.ID)
		if summary != "" {
			fmt.Printf("    Summary:   %s\n", summary)
		}
		if location != "" {
			fmt.Printf("    Location:  %s\n", location)
		}
		if description != "" {
			fmt.Printf("    Desc:      %s\n", description)
		}
		fmt.Printf("    UID:       %s\n", ev.UID)
		fmt.Printf("    Start:     %s\n", start.Format(time.RFC3339))
		fmt.Printf("    End:       %s\n", evEnd.Format(time.RFC3339))
		fmt.Printf("    Timezone:  %s / %s\n", ev.StartTimezone, ev.EndTimezone)
		fmt.Printf("    Full Day:  %v\n", bool(ev.FullDay))
		fmt.Printf("    Author:    %s\n", ev.Author)
		if len(ev.Attendees) > 0 {
			fmt.Printf("    Attendees: %d\n", len(ev.Attendees))
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
// extracts SUMMARY, DESCRIPTION, and LOCATION from the iCalendar VEVENT data.
func decryptSharedEvent(ev proton.CalendarEvent, calKR *crypto.KeyRing) (summary, description, location string) {
	if calKR == nil || len(ev.SharedEvents) == 0 {
		return
	}

	// Decode the shared key packet (used as the symmetric key packet for all
	// SharedEvents parts on this event).
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
		// Parse iCalendar properties from the decrypted VEVENT fragment.
		if v := icalProp(decrypted, "SUMMARY"); v != "" && summary == "" {
			summary = v
		}
		if v := icalProp(decrypted, "DESCRIPTION"); v != "" && description == "" {
			description = v
		}
		if v := icalProp(decrypted, "LOCATION"); v != "" && location == "" {
			location = v
		}
	}
	return
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
	// Unfold: iCalendar continuation lines start with a space or tab.
	ical = strings.ReplaceAll(ical, "\r\n ", "")
	ical = strings.ReplaceAll(ical, "\r\n\t", "")
	ical = strings.ReplaceAll(ical, "\n ", "")
	ical = strings.ReplaceAll(ical, "\n\t", "")

	for _, line := range strings.Split(ical, "\n") {
		line = strings.TrimRight(line, "\r")
		// Match "KEY:value" or "KEY;params:value"
		if strings.HasPrefix(line, key+":") {
			return line[len(key)+1:]
		}
		if strings.HasPrefix(line, key+";") {
			idx := strings.Index(line, ":")
			if idx >= 0 {
				return line[idx+1:]
			}
		}
	}
	return ""
}

func cmdMail(ctx context.Context, args []string) {
	m, c := login(ctx)
	defer c.Close()
	defer m.Close()

	limitStr := getArg(args, "--limit=", "50")
	limit, _ := strconv.Atoi(limitStr)
	if limit <= 0 {
		limit = 50
	}

	unreadOnly := hasFlag(args, "--unread")

	// Desc=true fetches newest first from the API.
	filter := proton.MessageFilter{
		LabelID: "0", // Inbox
		Desc:    proton.Bool(true),
	}

	// GetMessageMetadata handles pagination internally (fetches all pages).
	messages, err := c.GetMessageMetadata(ctx, filter)
	if err != nil {
		fatal("get messages", err)
	}

	// Apply unread filter in Go (Proton API MessageFilter has no Unread field).
	if unreadOnly {
		filtered := messages[:0]
		for _, msg := range messages {
			if bool(msg.Unread) {
				filtered = append(filtered, msg)
			}
		}
		messages = filtered
	}

	if len(messages) == 0 {
		if unreadOnly {
			fmt.Println("No unread messages in inbox.")
		} else {
			fmt.Println("No messages in inbox.")
		}
		return
	}

	// Sort newest first — the API returns oldest first by default.
	sort.Slice(messages, func(i, j int) bool {
		return messages[i].Time > messages[j].Time
	})

	total := len(messages)
	if len(messages) > limit {
		messages = messages[:limit]
	}

	label := "messages"
	if unreadOnly {
		label = "unread messages"
	}
	fmt.Printf("Inbox (%d %s, showing %d newest):\n\n", total, label, len(messages))
	for i, msg := range messages {
		t := time.Unix(msg.Time, 0).UTC()
		fmt.Printf("[%d] %s\n", i+1, msg.Subject)
		if msg.Sender != nil {
			fmt.Printf("    From:    %s <%s>\n", msg.Sender.Name, msg.Sender.Address)
		}
		fmt.Printf("    Date:    %s\n", t.Format(time.RFC3339))
		fmt.Printf("    ID:      %s\n", msg.ID)
		fmt.Printf("    Unread:  %v\n", bool(msg.Unread))
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
		LabelID: "2", // Sent label
		Desc:    proton.Bool(true),
	}

	// GetMessageMetadata paginates internally; Desc=true gives newest first.
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
		fatal("get message counts", err)
	}

	// Label ID → human name for the system labels.
	systemLabels := map[string]string{
		"0":  "Inbox",
		"1":  "All Drafts",
		"2":  "All Sent",
		"3":  "Trash",
		"4":  "Spam",
		"5":  "All Mail",
		"6":  "Archive",
		"7":  "Sent",
		"8":  "Drafts",
		"10": "Outbox",
		"12": "Starred",
		"15": "Scheduled",
	}

	fmt.Println("Message counts by label:")
	for _, g := range counts {
		name, ok := systemLabels[g.LabelID]
		if !ok {
			name = "Label:" + g.LabelID
		}
		if g.Unread > 0 {
			fmt.Printf("  %-16s total=%-6d unread=%d\n", name, g.Total, g.Unread)
		} else {
			fmt.Printf("  %-16s total=%d\n", name, g.Total)
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
	m, c := login(ctx)
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
	fmt.Printf("Date:    %s\n", time.Unix(msg.Time, 0).UTC().Format(time.RFC3339))
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
	clean := ids[:0]
	for _, id := range ids {
		id = strings.TrimSpace(id)
		if id != "" {
			clean = append(clean, id)
		}
	}

	// Batch mark-read: pass all IDs in a single API call.
	if err := c.MarkMessagesRead(ctx, clean...); err != nil {
		fmt.Fprintf(os.Stderr, "Error: failed to mark messages as read: %v\n", err)
		os.Exit(1)
	}

	fmt.Printf("Marked %d messages as read.\n", len(clean))
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

	isHTML := false
	for _, a := range args {
		if a == "--html" {
			isHTML = true
		}
	}

	mimeType := rfc822.TextPlain
	if isHTML {
		mimeType = rfc822.TextHTML
	}

	toList := parseAddressList(toStr)
	ccList := parseAddressList(ccStr)

	password := []byte(os.Getenv("PROTON_PASSWORD"))
	m, c := login(ctx)
	defer c.Close()
	defer m.Close()

	_, addr, addrKR := unlockKeys(ctx, c, password)

	draft, err := c.CreateDraft(ctx, addrKR, proton.CreateDraftReq{
		Message: proton.DraftTemplate{
			Subject:  subject,
			Sender:   &mail.Address{Address: addr.Email},
			ToList:   toList,
			CCList:   ccList,
			Body:     bodyText,
			MIMEType: mimeType,
		},
	})
	if err != nil {
		fatal("create draft", err)
	}

	sent, err := sendDraft(ctx, c, addrKR, draft.ID, bodyText, mimeType, toList, ccList)
	if err != nil {
		fatal("send draft", err)
	}

	fmt.Printf("Email sent successfully!\n")
	fmt.Printf("  Message ID: %s\n", sent.ID)
	fmt.Printf("  Subject:    %s\n", sent.Subject)
	fmt.Printf("  To:         %s\n", toStr)
	if ccStr != "" {
		fmt.Printf("  CC:         %s\n", ccStr)
	}
}

// sendDraft builds recipient send preferences and sends the named draft.
func sendDraft(
	ctx context.Context,
	c *proton.Client,
	addrKR *crypto.KeyRing,
	draftID, bodyText string,
	mimeType rfc822.MIMEType,
	toList, ccList []*mail.Address,
) (proton.Message, error) {
	allRecipients := make(map[string]proton.SendPreferences)
	for _, rcpt := range append(toList, ccList...) {
		email := rcpt.Address
		pubKeys, recipientType, err := c.GetPublicKeys(ctx, email)
		if err != nil {
			return proton.Message{}, fmt.Errorf("get public keys for %s: %w", email, err)
		}
		if recipientType == proton.RecipientTypeInternal && len(pubKeys) > 0 {
			rcptKR, err := pubKeys.GetKeyRing()
			if err != nil {
				return proton.Message{}, fmt.Errorf("build keyring for %s: %w", email, err)
			}
			allRecipients[email] = proton.SendPreferences{
				Encrypt:          true,
				PubKey:           rcptKR,
				SignatureType:    proton.DetachedSignature,
				EncryptionScheme: proton.InternalScheme,
				MIMEType:         mimeType,
			}
		} else {
			allRecipients[email] = proton.SendPreferences{
				Encrypt:          false,
				SignatureType:    proton.NoSignature,
				EncryptionScheme: proton.ClearScheme,
				MIMEType:         mimeType,
			}
		}
	}

	var sendReq proton.SendDraftReq
	internalPrefs := make(map[string]proton.SendPreferences)
	clearPrefs := make(map[string]proton.SendPreferences)
	for email, prefs := range allRecipients {
		if prefs.EncryptionScheme == proton.InternalScheme {
			internalPrefs[email] = prefs
		} else {
			clearPrefs[email] = prefs
		}
	}
	if len(internalPrefs) > 0 {
		if err := sendReq.AddTextPackage(addrKR, bodyText, mimeType, internalPrefs, nil); err != nil {
			return proton.Message{}, fmt.Errorf("add internal package: %w", err)
		}
	}
	if len(clearPrefs) > 0 {
		if err := sendReq.AddTextPackage(addrKR, bodyText, mimeType, clearPrefs, nil); err != nil {
			return proton.Message{}, fmt.Errorf("add clear package: %w", err)
		}
	}

	return c.SendDraft(ctx, draftID, sendReq)
}

func cmdReplyMail(ctx context.Context, args []string) {
	msgID := getArg(args, "--id=", "")
	bodyText := getArg(args, "--body=", "")
	replyAll := hasFlag(args, "--all")

	if msgID == "" {
		fmt.Fprintln(os.Stderr, "Error: --id=MSGID is required")
		os.Exit(1)
	}
	if bodyText == "" {
		fmt.Fprintln(os.Stderr, "Error: --body=TEXT is required (stdin is blocked by Landlock)")
		os.Exit(1)
	}

	password := []byte(os.Getenv("PROTON_PASSWORD"))
	m, c := login(ctx)
	defer c.Close()
	defer m.Close()

	_, addr, addrKR := unlockKeys(ctx, c, password)

	// Fetch original message for headers.
	orig, err := c.GetMessage(ctx, msgID)
	if err != nil {
		fatal("get original message", err)
	}

	// Build subject with Re: prefix.
	subject := orig.Subject
	if !strings.HasPrefix(strings.ToLower(subject), "re:") {
		subject = "Re: " + subject
	}

	// Reply goes to original sender; reply-all adds original To recipients as CC.
	toList := []*mail.Address{}
	if orig.Sender != nil {
		toList = append(toList, &mail.Address{Name: orig.Sender.Name, Address: orig.Sender.Address})
	}
	ccList := []*mail.Address{}
	if replyAll {
		for _, a := range orig.ToList {
			if !strings.EqualFold(a.Address, addr.Email) {
				ccList = append(ccList, &mail.Address{Name: a.Name, Address: a.Address})
			}
		}
	}

	mimeType := rfc822.TextPlain

	draft, err := c.CreateDraft(ctx, addrKR, proton.CreateDraftReq{
		Message: proton.DraftTemplate{
			Subject:  subject,
			Sender:   &mail.Address{Address: addr.Email},
			ToList:   toList,
			CCList:   ccList,
			Body:     bodyText,
			MIMEType: mimeType,
		},
		ParentID:     orig.ID,
		Action:       proton.ReplyAction,
	})
	if err != nil {
		fatal("create reply draft", err)
	}

	sent, err := sendDraft(ctx, c, addrKR, draft.ID, bodyText, mimeType, toList, ccList)
	if err != nil {
		fatal("send reply", err)
	}

	// Auto-mark original as read after replying.
	if bool(orig.Unread) {
		c.MarkMessagesRead(ctx, orig.ID)
	}

	fmt.Printf("Reply sent!\n")
	fmt.Printf("  Reply ID:  %s\n", sent.ID)
	fmt.Printf("  Subject:   %s\n", sent.Subject)
	if orig.Sender != nil {
		fmt.Printf("  To:        %s <%s>\n", orig.Sender.Name, orig.Sender.Address)
	}
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
	clean := ids[:0]
	for _, id := range ids {
		id = strings.TrimSpace(id)
		if id != "" {
			clean = append(clean, id)
		}
	}

	// LabelMessages with Trash label ID ("3") moves messages to trash.
	if err := c.LabelMessages(ctx, clean, "3"); err != nil {
		fmt.Fprintf(os.Stderr, "Error: failed to trash messages: %v\n", err)
		os.Exit(1)
	}

	fmt.Printf("Moved %d messages to trash.\n", len(clean))
}

func cmdLabels(ctx context.Context) {
	m, c := login(ctx)
	defer c.Close()
	defer m.Close()

	// Fetch user-created labels and folders (system labels excluded by type filter).
	custom, err := c.GetLabels(ctx, proton.LabelTypeLabel, proton.LabelTypeFolder)
	if err != nil {
		fatal("get labels", err)
	}

	if len(custom) == 0 {
		fmt.Println("No custom labels or folders.")
		return
	}

	fmt.Printf("Custom labels and folders (%d):\n\n", len(custom))
	for _, l := range custom {
		lType := "label"
		if l.Type == proton.LabelTypeFolder {
			lType = "folder"
		}
		fmt.Printf("  ID: %-30s  Type: %-7s  Name: %s\n", l.ID, lType, l.Name)
	}
}

func main() {
	if len(os.Args) < 2 {
		usage()
	}

	// 120s gives enough headroom for mark-read of large batches + key operations.
	// The old 60s limit caused spurious timeouts when the inbox had many messages.
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
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
