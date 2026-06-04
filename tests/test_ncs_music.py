import pytest

from lofi_maker.sources.ncs_music import (
    MAX_DOWNLOAD_LIMIT,
    build_search_url,
    parse_search_page,
    safe_output_name,
    trim_limit,
)


def test_parse_search_page_reads_player_rows():
    html = """
    <tr>
      <td>
        <a class="player-play"
           data-url="https://ncsmusic.s3.eu-west-1.amazonaws.com/tracks/000/002/101/deep-end.mp3"
           data-artistraw="FLOTE, Fendy Cisneros"
           data-track="Deep End"
           data-cover="https://ncsmusic.s3.eu-west-1.amazonaws.com/tracks/cover.jpg"
           data-tid="b06b1c0b-be67-41f8-99e4-a578f250dad6"
           data-versions="Regular"
           data-genre="Melodic Dubstep"></a>
      </td>
      <td><a href="/deepend"><p>Deep End</p></a></td>
    </tr>
    """

    tracks = parse_search_page(html)

    assert len(tracks) == 1
    assert tracks[0].id == "b06b1c0b-be67-41f8-99e4-a578f250dad6"
    assert tracks[0].title == "Deep End"
    assert tracks[0].artist == "FLOTE, Fendy Cisneros"
    assert tracks[0].page_url == "https://ncs.io/deepend"
    assert tracks[0].genre == "Melodic Dubstep"
    assert tracks[0].versions == "Regular"
    assert safe_output_name(tracks[0]) == "b06b1c0b_deep-end.mp3"


def test_build_search_url_accepts_exact_ncs_url():
    url = build_search_url("https://ncs.io/music-search?q=&genre=&mood=20", page=2)

    assert url == "https://ncs.io/music-search?q=&genre=&mood=20&page=2"


def test_build_search_url_accepts_filters():
    url = build_search_url("lofi", genre="12", mood="20", version="regular", page=1)

    assert url == "https://ncs.io/music-search?q=lofi&genre=12&mood=20&version%5B%5D=regular"


def test_trim_limit_rejects_large_ncs_downloads():
    with pytest.raises(ValueError):
        trim_limit(MAX_DOWNLOAD_LIMIT + 1)
