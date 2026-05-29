"""Simple HTTP/HTML extraction provider for Hermes web_extract."""

from __future__ import annotations

import ipaddress
import socket
import threading
from html.parser import HTMLParser
from typing import Any, Dict, List
from urllib.parse import urljoin, urlparse

import httpx

from agent.web_search_provider import WebSearchProvider
from tools.url_safety import is_safe_url


_MAX_TEXT_CHARS = 2_000_000
_MAX_RESPONSE_BYTES = 2_500_000
_MAX_REDIRECTS = 5
_USER_AGENT = "HermesAgentSimpleExtract/1.0 (+https://hermes-agent.nousresearch.com/docs/)"
_DNS_PIN_LOCK = threading.Lock()


class _TextHTMLParser(HTMLParser):
    """Minimal text extractor that ignores scripts/styles and captures title."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self._skip_depth = 0
        self._in_title = False
        self._title_parts: List[str] = []
        self._parts: List[str] = []

    def handle_starttag(self, tag: str, attrs: List[tuple[str, str | None]]) -> None:
        tag = tag.lower()
        if tag in {"script", "style", "noscript", "template"}:
            self._skip_depth += 1
        elif tag == "title":
            self._in_title = True
        elif tag in {"p", "br", "div", "section", "article", "header", "footer", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6"}:
            self._parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        if tag in {"script", "style", "noscript", "template"} and self._skip_depth:
            self._skip_depth -= 1
        elif tag == "title":
            self._in_title = False
        elif tag in {"p", "div", "section", "article", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6"}:
            self._parts.append("\n")

    def handle_data(self, data: str) -> None:
        if not data:
            return
        if self._in_title:
            self._title_parts.append(data)
        if self._skip_depth == 0:
            self._parts.append(data)

    @property
    def title(self) -> str:
        return _normalize_whitespace(" ".join(self._title_parts))

    @property
    def text(self) -> str:
        lines = []
        for line in "".join(self._parts).splitlines():
            line = _normalize_whitespace(line)
            if line:
                lines.append(line)
        return "\n".join(lines)


def _normalize_whitespace(value: str) -> str:
    return " ".join(value.split())


def _title_from_url(url: str) -> str:
    parsed = urlparse(url)
    return parsed.netloc or url


def _blocked_ip(ip_str: str) -> bool:
    ip = ipaddress.ip_address(ip_str)
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
        ip = ip.ipv4_mapped
    if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved:
        return True
    if ip.is_multicast or ip.is_unspecified:
        return True
    if isinstance(ip, ipaddress.IPv4Address) and ip in ipaddress.ip_network("100.64.0.0/10"):
        return True
    return False


def _safe_addrinfo(hostname: str, port: int) -> list[tuple[Any, ...]]:
    """Resolve once and keep only public addresses for the actual socket connect."""
    infos = socket.getaddrinfo(hostname, port, socket.AF_UNSPEC, socket.SOCK_STREAM)
    safe: list[tuple[Any, ...]] = []
    for info in infos:
        sockaddr = info[4]
        ip_str = str(sockaddr[0])
        try:
            if _blocked_ip(ip_str):
                raise ValueError(f"resolved private/internal address blocked: {hostname} -> {ip_str}")
        except ValueError:
            raise
        safe.append(info)
    if not safe:
        raise ValueError(f"DNS resolution returned no safe addresses for {hostname}")
    return safe


def _httpx_raw_hostname(url: str) -> str:
    """Return the ASCII raw host that httpx/httpcore uses for socket resolution."""
    raw_host = httpx.URL(url).raw_host
    if not raw_host:
        raise ValueError("URL missing hostname")
    return raw_host.decode("ascii").lower().rstrip(".")


class SimpleExtractWebProvider(WebSearchProvider):
    """Credential-free extractor for plain public HTML/text pages."""

    @property
    def name(self) -> str:
        return "simple"

    @property
    def display_name(self) -> str:
        return "Simple HTTP Extract"

    def is_available(self) -> bool:
        return True

    def supports_search(self) -> bool:
        return False

    def supports_extract(self) -> bool:
        return True

    def get_setup_schema(self) -> Dict[str, Any]:
        return {
            "name": self.display_name,
            "badge": "free",
            "tag": "No API key. Extracts ordinary public HTML/text pages; no JS rendering or PDF OCR.",
            "env_vars": [],
        }

    def extract(self, urls: List[str], **kwargs: Any) -> List[Dict[str, Any]]:
        results: List[Dict[str, Any]] = []
        timeout = httpx.Timeout(20.0, connect=10.0)
        headers = {"User-Agent": _USER_AGENT, "Accept": "text/html,text/plain,application/xhtml+xml;q=0.9,*/*;q=0.1"}
        with httpx.Client(follow_redirects=False, timeout=timeout, headers=headers, trust_env=False) as client:
            for url in urls:
                results.append(self._extract_one(client, url))
        return results

    def _extract_one(self, client: httpx.Client, url: str) -> Dict[str, Any]:
        base: Dict[str, Any] = {"url": url, "title": "", "content": "", "raw_content": "", "metadata": {"backend": self.name}}
        if not is_safe_url(url):
            base["error"] = "Blocked: URL targets a private or internal network address"
            return base
        try:
            response = self._get_with_safe_redirects(client, url)
        except Exception as exc:  # noqa: BLE001 - report per URL, do not fail batch
            base["error"] = f"Simple extract failed: {exc}"
            return base

        content_type = response.headers.get("content-type", "").split(";", 1)[0].strip().lower()
        base["metadata"] = {
            "backend": self.name,
            "status_code": response.status_code,
            "content_type": content_type,
            "final_url": str(response.url),
        }

        if content_type == "application/pdf" or url.lower().split("?", 1)[0].endswith(".pdf"):
            response.close()
            base["title"] = _title_from_url(url)
            base["error"] = "Simple extract does not support PDF content; configure Firecrawl, Tavily, Exa, or Parallel for PDF extraction."
            return base

        try:
            text = self._read_text_with_cap(response)
        except Exception as exc:  # noqa: BLE001 - report per URL, do not fail batch
            base["title"] = _title_from_url(str(response.url))
            base["error"] = f"Simple extract failed: {exc}"
            return base
        finally:
            response.close()
        if "html" in content_type or "xml" in content_type or "<html" in text[:500].lower():
            parser = _TextHTMLParser()
            parser.feed(text)
            parser.close()
            base["title"] = parser.title or _title_from_url(str(response.url))
            base["content"] = parser.text
            base["raw_content"] = parser.text
        elif content_type.startswith("text/") or not content_type:
            plain = text.strip()
            base["title"] = _title_from_url(str(response.url))
            base["content"] = plain
            base["raw_content"] = plain
        else:
            base["title"] = _title_from_url(str(response.url))
            base["error"] = f"Simple extract only supports HTML/text content, got {content_type or 'unknown content type'}."
        return base

    def _get_with_safe_redirects(self, client: httpx.Client, url: str) -> httpx.Response:
        current_url = url
        for _ in range(_MAX_REDIRECTS + 1):
            if not is_safe_url(current_url):
                raise ValueError("redirect target blocked by URL safety policy")
            parsed = urlparse(current_url)
            hostname = (parsed.hostname or "").strip().lower().rstrip(".")
            if not hostname:
                raise ValueError("URL missing hostname")
            raw_hostname = _httpx_raw_hostname(current_url)
            pinned_hostnames = {hostname, raw_hostname}
            port = parsed.port or (443 if parsed.scheme == "https" else 80)
            pinned_addrinfo = _safe_addrinfo(raw_hostname, port)
            request = client.build_request("GET", current_url)
            original_getaddrinfo = socket.getaddrinfo

            def pinned_getaddrinfo(host: str, requested_port: Any, *args: Any, **kwargs: Any) -> list[tuple[Any, ...]]:
                normalized_host = str(host).strip().lower().rstrip(".")
                port_matches = requested_port in {port, str(port), None}
                if normalized_host in pinned_hostnames and port_matches:
                    return pinned_addrinfo
                return original_getaddrinfo(host, requested_port, *args, **kwargs)

            with _DNS_PIN_LOCK:
                socket.getaddrinfo = pinned_getaddrinfo
                try:
                    response = client.send(request, stream=True)
                finally:
                    socket.getaddrinfo = original_getaddrinfo
            if not response.is_redirect:
                try:
                    response.raise_for_status()
                except Exception:
                    response.close()
                    raise
                return response
            location = response.headers.get("location")
            response.close()
            if not location:
                raise ValueError("redirect response missing Location header")
            current_url = urljoin(str(response.url), location)
        raise ValueError(f"too many redirects (>{_MAX_REDIRECTS})")

    def _read_text_with_cap(self, response: httpx.Response) -> str:
        chunks: list[bytes] = []
        total = 0
        for chunk in response.iter_bytes():
            if not chunk:
                continue
            total += len(chunk)
            if total > _MAX_RESPONSE_BYTES:
                raise ValueError(f"response too large (>{_MAX_RESPONSE_BYTES} bytes)")
            chunks.append(chunk)
        return b"".join(chunks).decode(response.encoding or "utf-8", errors="replace")[:_MAX_TEXT_CHARS]
