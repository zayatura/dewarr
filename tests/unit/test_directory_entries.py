import os

from app.importing.filesystem import list_entries, scan_entries


def test_a_directory_handle_lists_entries_created_through_it(tmp_path):
    # btrfs lists, through a handle, only the entries present when it was opened or
    # last rewound. Staging creates files through a handle and then verifies them.
    fd = os.open(tmp_path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        assert list_entries(fd) == []
        for name in ("book.m4b", "metadata.opf"):
            os.close(os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o666, dir_fd=fd))
        assert sorted(list_entries(fd)) == ["book.m4b", "metadata.opf"]
        os.close(os.open("cover.jpg", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o666, dir_fd=fd))
        with scan_entries(fd) as entries:
            assert sorted(entry.name for entry in entries) == [
                "book.m4b",
                "cover.jpg",
                "metadata.opf",
            ]
    finally:
        os.close(fd)
